import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { AgentSummary, ChannelSummary } from '../../core/api.models';
import { startPolling } from '../../core/polling';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

/** Cached last-activity timestamp per channel, keyed by name; refreshed only when last_seq moves. */
interface ActivityCacheEntry {
  seq: number;
  ts: string;
}

@Component({
  selector: 'app-channels-page',
  imports: [FormsModule, RelativeTimePipe],
  templateUrl: './channels.page.html',
  styleUrl: './channels.page.css',
})
export class ChannelsPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);

  protected readonly channels = signal<ChannelSummary[]>([]);
  protected readonly agents = signal<AgentSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly newName = signal('');
  protected readonly selectedMembers = signal<Set<string>>(new Set());
  protected readonly note = signal('');
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  protected readonly closingName = signal<string | null>(null);

  private readonly activityCache = new Map<string, ActivityCacheEntry>();
  protected readonly activityVersion = signal(0);

  private stopPolling?: () => void;

  ngOnInit(): void {
    void this.refresh();
    this.stopPolling = startPolling(() => void this.refresh());
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
  }

  protected async refresh(): Promise<void> {
    try {
      const [{ channels }, { agents }] = await Promise.all([
        this.api.listChannels('open'),
        this.api.listAgents(),
      ]);
      this.channels.set(channels);
      this.agents.set(agents);
      this.error.set(null);
      void this.refreshActivity(channels);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Failed to load channels.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Best-effort "idle time" indicator. The list endpoint gives last_seq but
   * not a last-activity timestamp, so for channels whose last_seq changed
   * since our last check we fetch just that one message (since=last_seq-1)
   * to read its ts. Cached by seq so a steady channel costs nothing extra.
   */
  private async refreshActivity(channels: ChannelSummary[]): Promise<void> {
    await Promise.all(
      channels.map(async (ch) => {
        if (ch.last_seq === 0) return;
        const cached = this.activityCache.get(ch.name);
        if (cached && cached.seq === ch.last_seq) return;
        try {
          const page = await this.api.getChannelMessages(ch.name, ch.last_seq - 1);
          const last = page.messages.at(-1);
          if (last) {
            this.activityCache.set(ch.name, { seq: last.seq, ts: last.ts });
          }
        } catch {
          // best-effort only; leave stale/created_at fallback in place
        }
      }),
    );
    this.activityVersion.update((v) => v + 1);
  }

  protected lastActivity(ch: ChannelSummary): string {
    this.activityVersion(); // read for reactivity
    return this.activityCache.get(ch.name)?.ts ?? ch.created_at;
  }

  protected toggleMember(name: string): void {
    this.selectedMembers.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  protected async createChannel(): Promise<void> {
    const name = this.newName().trim();
    const members = [...this.selectedMembers()];
    if (!name || members.length === 0) return;
    this.creating.set(true);
    this.createError.set(null);
    try {
      const note = this.note().trim();
      await this.api.createChannel({ name, members, ...(note ? { note } : {}) });
      this.newName.set('');
      this.selectedMembers.set(new Set());
      this.note.set('');
      await this.refresh();
    } catch (err) {
      this.createError.set(err instanceof ApiError ? err.message : 'Failed to create channel.');
    } finally {
      this.creating.set(false);
    }
  }

  protected async closeChannel(name: string): Promise<void> {
    if (!confirm(`Close channel "${name}"? This archives it and ends the conversation.`)) {
      return;
    }
    this.closingName.set(name);
    try {
      await this.api.closeChannel(name);
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : `Failed to close "${name}".`);
    } finally {
      this.closingName.set(null);
    }
  }
}
