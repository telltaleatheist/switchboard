import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { BlobRef, ChannelSummary, ChannelWsFrame, Message } from '../../core/api.models';
import { startPolling } from '../../core/polling';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

type WsStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

@Component({
  selector: 'app-live-page',
  imports: [FormsModule, RelativeTimePipe],
  templateUrl: './live.page.html',
  styleUrl: './live.page.css',
})
export class LivePage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);

  @ViewChild('scrollArea') private scrollArea?: ElementRef<HTMLDivElement>;

  protected readonly channels = signal<ChannelSummary[]>([]);
  protected readonly channelsError = signal<string | null>(null);
  protected readonly selectedChannel = signal<string | null>(null);

  protected readonly messages = signal<Message[]>([]);
  protected readonly wsStatus = signal<WsStatus>('idle');
  protected readonly closeInfo = signal<{ code: number; reason: string } | null>(null);
  protected readonly shutdownNotice = signal(false);

  protected readonly composeText = signal('');
  /** Optional — empty means the message goes out with no subject at all. */
  protected readonly composeSubject = signal('');
  /** Uploaded and waiting to ride on the next send. */
  protected readonly pendingAttachments = signal<BlobRef[]>([]);
  protected readonly uploading = signal(false);
  /** '' = everyone; otherwise a member name for an addressed (to:) send. */
  protected readonly recipient = signal('');
  protected readonly sending = signal(false);
  protected readonly sendError = signal<string | null>(null);

  private ws: WebSocket | null = null;
  private stopPolling?: () => void;
  private stickToBottom = true;
  /** Set when a channel is opened: the next render jumps to the newest message. */
  private forceBottom = true;

  ngOnInit(): void {
    void this.refreshChannels();
    this.stopPolling = startPolling(() => void this.refreshChannels());
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
    this.ws?.close();
  }

  private async refreshChannels(): Promise<void> {
    try {
      const { channels } = await this.api.listChannels('open');
      this.channels.set(channels);
      this.channelsError.set(null);
    } catch (err) {
      this.channelsError.set(err instanceof ApiError ? err.message : 'Failed to load channels.');
    }
  }

  protected selectChannel(name: string): void {
    if (!name) return;
    this.selectedChannel.set(name);
    this.recipient.set('');
    this.connect(name);
  }

  /** Members of the currently selected channel, for the recipient picker. */
  protected channelMembers(): string[] {
    const name = this.selectedChannel();
    if (!name) return [];
    return this.channels().find((c) => c.name === name)?.members ?? [];
  }

  protected reconnect(): void {
    const name = this.selectedChannel();
    if (name) this.connect(name);
  }

  private connect(name: string): void {
    this.ws?.close();
    this.messages.set([]);
    this.stickToBottom = true;
    this.forceBottom = true;
    this.closeInfo.set(null);
    this.shutdownNotice.set(false);
    this.wsStatus.set('connecting');

    const url = this.api.channelWsUrl(name, 0);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsStatus.set('open');
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let frame: ChannelWsFrame;
      try {
        frame = JSON.parse(event.data as string) as ChannelWsFrame;
      } catch {
        return;
      }
      if (frame.type === 'message') {
        this.messages.update((list) => [...list, frame.message]);
        this.scheduleScroll();
      } else if (frame.type === 'shutdown') {
        this.shutdownNotice.set(true);
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.wsStatus.set('error');
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.wsStatus.set('closed');
      this.closeInfo.set({ code: event.code, reason: event.reason || '(no reason given)' });
    };
  }

  protected onScroll(): void {
    const el = this.scrollArea?.nativeElement;
    if (!el) return;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    // Reading something further up ends the open-the-channel jump: from here
    // on, the feed follows only while you are already at the bottom. Our own
    // programmatic scrolls land AT the bottom, so they never trip this.
    if (!this.stickToBottom) this.forceBottom = false;
  }

  /**
   * Scrolling has to wait for the DOM to actually carry the new message.
   * A microtask runs BEFORE Angular renders, so it measured a stale
   * scrollHeight and parked the feed one screen short of the newest message —
   * which is exactly the bug this was supposed to fix. The frame callback
   * covers the normal case; the short timeout covers a replay whose layout
   * settles a beat later. Both are idempotent.
   */
  protected scheduleScroll(): void {
    requestAnimationFrame(() => this.maybeScrollToBottom());
    setTimeout(() => this.maybeScrollToBottom(), 80);
  }

  private maybeScrollToBottom(): void {
    const el = this.scrollArea?.nativeElement;
    if (!el) return;
    // A freshly opened channel always lands at the newest message — you are
    // here to read what just happened, not the top of the replay. After that,
    // only follow along if the reader has not scrolled up to look at
    // something.
    // forceBottom is NOT cleared here: a replay arrives as many frames, and
    // clearing on the first one leaves the feed parked one screen short of
    // the newest message. It ends when the reader scrolls up (onScroll).
    if (!this.stickToBottom && !this.forceBottom) return;
    el.scrollTop = el.scrollHeight;
  }

  /**
   * Upload straight away rather than at send time: the operator sees the
   * attachment land (or fail) while still composing, instead of losing a typed
   * message to a failed upload.
   */
  protected async onFilesPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // let the same file be picked again later
    if (files.length === 0) return;
    this.uploading.set(true);
    this.sendError.set(null);
    try {
      for (const file of files) {
        const blob = await this.api.uploadBlob(file);
        this.pendingAttachments.update((list) =>
          list.some((b) => b.id === blob.id) ? list : [...list, blob],
        );
      }
    } catch (err) {
      this.sendError.set(err instanceof ApiError ? err.message : 'Failed to upload the attachment.');
    } finally {
      this.uploading.set(false);
    }
  }

  protected dropAttachment(id: string): void {
    this.pendingAttachments.update((list) => list.filter((b) => b.id !== id));
  }

  protected isImage(blob: BlobRef): boolean {
    return blob.media_type.startsWith('image/');
  }

  protected blobUrl(id: string): string {
    return this.api.blobUrl(id);
  }

  protected sizeLabel(bytes: number): string {
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected toLabel(to: string[] | null): string {
    return to && to.length > 0 ? to.join(', ') : 'everyone';
  }

  protected replyLabel(inReplyTo: number | number[]): string {
    const cited = Array.isArray(inReplyTo) ? inReplyTo : [inReplyTo];
    return cited.map((s) => `#${s}`).join(', ');
  }

  /**
   * Enter sends; Shift+Enter keeps its normal newline. Angular's key-event
   * plugin encodes held modifiers into the binding name, so this handler only
   * fires for a bare Enter — Shift+Enter never reaches it. preventDefault
   * stops the newline that would otherwise land before the send clears the box.
   */
  protected onEnter(event: Event): void {
    event.preventDefault();
    void this.sendMessage();
  }

  /**
   * Send as the reserved 'operator' sender. The subject is yours to write or
   * to leave empty — agents must headline every message (protocol rule 1),
   * the human at the console does not, and inventing one by copying the first
   * line only echoed the same text into both fields. The message appears in
   * the feed via our own WS — operator sockets are unfiltered.
   */
  protected async sendMessage(): Promise<void> {
    const name = this.selectedChannel();
    const body = this.composeText().trim();
    if (!name || body.length === 0 || this.sending() || this.uploading()) return;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      const to = this.recipient();
      const subject = this.composeSubject().trim();
      const attachments = this.pendingAttachments().map((b) => b.id);
      await this.api.sendChannelMessage(name, subject || null, body, to ? [to] : undefined, attachments);
      this.composeText.set('');
      this.composeSubject.set('');
      this.pendingAttachments.set([]);
    } catch (err) {
      this.sendError.set(err instanceof ApiError ? err.message : 'Failed to send the message.');
    } finally {
      this.sending.set(false);
    }
  }
}
