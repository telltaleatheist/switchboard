import { Component, Input, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import type { BlobRef, Message } from '../../core/api.models';
import { RelativeTimePipe } from '../relative-time.pipe';

/**
 * One message, wherever it appears. The live feed and an archived transcript
 * render through THIS component and nothing else — that is what keeps a closed
 * line as readable as an open one instead of the two drifting apart.
 */
/** Distinct at a glance on the console's warm charcoal, and none of them the accent. */
const SENDER_COLORS = ["#a78bfa", "#fb923c", "#34d399", "#f472b6", "#38bdf8", "#a3e635", "#fda4af"];

@Component({
  selector: 'app-message-card',
  imports: [RelativeTimePipe],
  templateUrl: './message-card.html',
  styleUrl: './message-card.css',
  host: {
    '[attr.data-sender]': 'msg()?.sender',
    '[class.quiet]': 'isQuiet()',
    '[style.--sender-color]': 'senderColor()',
  },
})
export class MessageCard {
  private readonly api = inject(ApiService);
  private readonly _message = signal<Message | null>(null);

  @Input({ required: true }) set message(value: Message) {
    this._message.set(value);
  }

  /**
   * A stable colour per sender. Hashed from the name rather than assigned in
   * order, so an agent looks the same today, tomorrow, and in an archive read
   * six weeks from now — the point of the band is recognition, which a colour
   * that moves between sessions would defeat.
   */
  protected senderColor(): string {
    const name = this._message()?.sender ?? "";
    if (name === "operator") return "var(--accent)";
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return SENDER_COLORS[hash % SENDER_COLORS.length] as string;
  }

  /** Record-only and digest sends are for the record — they read at half weight. */
  protected isQuiet(): boolean {
    const msg = this._message();
    return msg !== null && msg.wake !== true;
  }

  /** Named msg(), not message(): the @Input above already owns that name. */
  protected msg(): Message | null {
    return this._message();
  }

  protected toLabel(to: string[] | null): string {
    return to && to.length > 0 ? to.join(', ') : 'everyone';
  }

  protected replyLabel(inReplyTo: number | number[]): string {
    const cited = Array.isArray(inReplyTo) ? inReplyTo : [inReplyTo];
    return cited.map((s) => `#${s}`).join(', ');
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
}
