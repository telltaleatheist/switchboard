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
    this.connect(name);
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
}
