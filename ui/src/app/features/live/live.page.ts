import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { ChannelSummary, ChannelWsFrame, Message } from '../../core/api.models';
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
  /** '' = everyone; otherwise a member name for an addressed (to:) send. */
  protected readonly recipient = signal('');
  protected readonly sending = signal(false);
  protected readonly sendError = signal<string | null>(null);

  private ws: WebSocket | null = null;
  private stopPolling?: () => void;
  private stickToBottom = true;

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
        queueMicrotask(() => this.maybeScrollToBottom());
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
  }

  private maybeScrollToBottom(): void {
    const el = this.scrollArea?.nativeElement;
    if (!el || !this.stickToBottom) return;
    el.scrollTop = el.scrollHeight;
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
   * Send to everyone in the channel as the reserved 'operator' sender. The
   * first line becomes the subject (protocol rule 1: the subject states the
   * conclusion); the full text is the body. The message appears in the feed
   * via our own WS — operator sockets are unfiltered.
   */
  protected async sendMessage(): Promise<void> {
    const name = this.selectedChannel();
    const text = this.composeText().trim();
    if (!name || text.length === 0 || this.sending()) return;
    // First line → subject, remainder → body. A single-line message has to
    // carry the same text in both (both fields are required); the feed
    // suppresses the body when it merely repeats the subject.
    const newline = text.indexOf('\n');
    const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
    const subject = firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
    const rest = newline === -1 ? '' : text.slice(newline + 1).trim();
    const body = rest.length > 0 ? rest : text;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      const to = this.recipient();
      await this.api.sendChannelMessage(name, subject, body, to ? [to] : undefined);
      this.composeText.set('');
    } catch (err) {
      this.sendError.set(err instanceof ApiError ? err.message : 'Failed to send the message.');
    } finally {
      this.sending.set(false);
    }
  }
}
