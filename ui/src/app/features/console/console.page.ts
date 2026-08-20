import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type {
  AgentSummary,
  ArchiveSummary,
  BlobRef,
  ChannelSummary,
  ChannelWsFrame,
  Message,
  PatchRequest,
} from '../../core/api.models';
import { ConfirmService } from '../../core/confirm.service';
import { startPolling } from '../../core/polling';
import { MessageCard } from '../../shared/message-card/message-card';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { SettingsDialog } from '../../shared/settings-dialog/settings-dialog';

type WsStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** What the centre column is showing. */
type Selection =
  | { kind: 'none' }
  | { kind: 'channel'; name: string }
  | { kind: 'archive'; id: number; name: string };

@Component({
  selector: 'app-console-page',
  imports: [FormsModule, MessageCard, RelativeTimePipe, SettingsDialog],
  templateUrl: './console.page.html',
  styleUrl: './console.page.css',
})
export class ConsolePage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly confirmService = inject(ConfirmService);

  @ViewChild('scrollArea') private scrollArea?: ElementRef<HTMLDivElement>;

  // ---- what exists -------------------------------------------------------
  protected readonly channels = signal<ChannelSummary[]>([]);
  protected readonly archives = signal<ArchiveSummary[]>([]);
  protected readonly agents = signal<AgentSummary[]>([]);
  protected readonly patchRequests = signal<PatchRequest[]>([]);
  protected readonly loadError = signal<string | null>(null);

  // ---- what is on screen -------------------------------------------------
  protected readonly selection = signal<Selection>({ kind: 'none' });
  protected readonly messages = signal<Message[]>([]);
  protected readonly wsStatus = signal<WsStatus>('idle');
  protected readonly shutdownNotice = signal(false);
  protected readonly loadingArchive = signal(false);

  // ---- filters -----------------------------------------------------------
  protected readonly filterFrom = signal('');
  protected readonly filterTo = signal('');
  protected readonly filterText = signal('');

  // ---- compose -----------------------------------------------------------
  protected readonly composeSubject = signal('');
  protected readonly composeText = signal('');
  protected readonly recipient = signal('');
  protected readonly pendingAttachments = signal<BlobRef[]>([]);
  protected readonly uploading = signal(false);
  protected readonly sending = signal(false);
  protected readonly sendError = signal<string | null>(null);

  // ---- dialogs -----------------------------------------------------------
  protected readonly settingsTab = signal<'welcome' | 'address' | 'join' | 'archives' | null>(null);
  protected readonly showPatchRequests = signal(false);
  protected readonly creatingLine = signal(false);
  protected readonly newLineName = signal('');
  protected readonly newLineNote = signal('');
  protected readonly newLineMembers = signal<Set<string>>(new Set());
  protected readonly createError = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);

  private ws: WebSocket | null = null;
  private stopPolling?: () => void;
  private stickToBottom = true;
  private forceBottom = true;

  ngOnInit(): void {
    void this.refresh();
    this.stopPolling = startPolling(() => void this.refresh());
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
    this.ws?.close();
  }

  // ------------------------------------------------------------------ data

  protected async refresh(): Promise<void> {
    try {
      const [{ channels }, { agents }, { archives }, { requests }] = await Promise.all([
        this.api.listChannels('open'),
        this.api.listAgents(),
        this.api.listArchives(),
        this.api.listPendingPatchRequests(),
      ]);
      this.channels.set(channels);
      this.agents.set(agents);
      this.archives.set(archives);
      this.patchRequests.set(requests);
      this.loadError.set(null);
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to load the switchboard.');
    }
  }

  /** The channel currently on screen, when one is. */
  protected readonly openChannel = computed(() => {
    const sel = this.selection();
    if (sel.kind !== 'channel') return null;
    return this.channels().find((c) => c.name === sel.name) ?? null;
  });

  protected readonly selectedArchive = computed(() => {
    const sel = this.selection();
    if (sel.kind !== 'archive') return null;
    return this.archives().find((a) => a.id === sel.id) ?? null;
  });

  /** Everyone who has spoken here, for the "from" filter. */
  protected readonly senders = computed(() =>
    [...new Set(this.messages().map((m) => m.sender))].sort((a, b) => a.localeCompare(b)),
  );

  protected readonly visibleMessages = computed(() => {
    const from = this.filterFrom();
    const to = this.filterTo();
    const text = this.filterText().trim().toLowerCase();
    return this.messages().filter((m) => {
      if (from && m.sender !== from) return false;
      // 'everyone' means the unaddressed traffic — the party line.
      if (to === '*everyone*' && m.to !== null) return false;
      if (to && to !== '*everyone*' && !(m.to ?? []).includes(to)) return false;
      if (text && !`${m.subject ?? ''} ${m.body}`.toLowerCase().includes(text)) return false;
      return true;
    });
  });

  protected filtersActive(): boolean {
    return this.filterFrom() !== '' || this.filterTo() !== '' || this.filterText().trim() !== '';
  }

  protected clearFilters(): void {
    this.filterFrom.set('');
    this.filterTo.set('');
    this.filterText.set('');
  }

  // ------------------------------------------------------------- selection

  protected openLine(name: string): void {
    this.selection.set({ kind: 'channel', name });
    this.resetView();
    this.connect(name);
  }

  protected async openArchive(archive: ArchiveSummary): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.wsStatus.set('idle');
    this.selection.set({ kind: 'archive', id: archive.id, name: archive.channel_name });
    this.resetView();
    this.loadingArchive.set(true);
    try {
      const detail = await this.api.getArchive(archive.id);
      this.messages.set(detail.messages ?? []);
      this.scheduleScroll();
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to open the archive.');
    } finally {
      this.loadingArchive.set(false);
    }
  }

  private resetView(): void {
    this.messages.set([]);
    this.clearFilters();
    this.recipient.set('');
    this.sendError.set(null);
    this.stickToBottom = true;
    this.forceBottom = true;
  }

  private connect(name: string): void {
    this.ws?.close();
    this.shutdownNotice.set(false);
    this.wsStatus.set('connecting');

    const ws = new WebSocket(this.api.channelWsUrl(name, 0));
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws === ws) this.wsStatus.set('open');
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
      if (this.ws === ws) this.wsStatus.set('error');
    };
    ws.onclose = () => {
      if (this.ws === ws) this.wsStatus.set('closed');
    };
  }

  protected reconnect(): void {
    const sel = this.selection();
    if (sel.kind === 'channel') this.connect(sel.name);
  }

  // --------------------------------------------------------------- scroll

  protected onScroll(): void {
    const el = this.scrollArea?.nativeElement;
    if (!el) return;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!this.stickToBottom) this.forceBottom = false;
  }

  /**
   * Scroll after the DOM has the new message, not before: a microtask runs
   * ahead of Angular's render and measures a stale height, which parks the
   * feed a screen short of the newest message.
   */
  protected scheduleScroll(): void {
    requestAnimationFrame(() => this.scrollToBottom());
    setTimeout(() => this.scrollToBottom(), 80);
  }

  private scrollToBottom(): void {
    const el = this.scrollArea?.nativeElement;
    if (!el) return;
    if (!this.stickToBottom && !this.forceBottom) return;
    el.scrollTop = el.scrollHeight;
  }

  // -------------------------------------------------------------- compose

  protected onEnter(event: Event): void {
    event.preventDefault();
    void this.send();
  }

  protected async send(): Promise<void> {
    const channel = this.openChannel();
    const body = this.composeText().trim();
    if (!channel || body.length === 0 || this.sending() || this.uploading()) return;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      const to = this.recipient();
      await this.api.sendChannelMessage(
        channel.name,
        this.composeSubject().trim() || null,
        body,
        to ? [to] : undefined,
        this.pendingAttachments().map((b) => b.id),
      );
      this.composeText.set('');
      this.composeSubject.set('');
      this.pendingAttachments.set([]);
      this.stickToBottom = true;
      this.forceBottom = true;
    } catch (err) {
      this.sendError.set(err instanceof ApiError ? err.message : 'Failed to send the message.');
    } finally {
      this.sending.set(false);
    }
  }

  protected async onFilesPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
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

  // ------------------------------------------------------- channel actions

  protected startNewLine(): void {
    this.newLineName.set('');
    this.newLineNote.set('');
    this.newLineMembers.set(new Set());
    this.createError.set(null);
    this.creatingLine.set(true);
  }

  protected toggleNewLineMember(name: string): void {
    this.newLineMembers.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  protected async createLine(): Promise<void> {
    const name = this.newLineName().trim();
    const members = [...this.newLineMembers()];
    if (name.length === 0 || members.length === 0) return;
    this.busy.set('create');
    this.createError.set(null);
    try {
      const note = this.newLineNote().trim();
      await this.api.createChannel({ name, members, ...(note ? { note } : {}) });
      this.creatingLine.set(false);
      await this.refresh();
      this.openLine(name);
    } catch (err) {
      this.createError.set(err instanceof ApiError ? err.message : 'Failed to open the line.');
    } finally {
      this.busy.set(null);
    }
  }

  protected async closeLine(name: string): Promise<void> {
    const ok = await this.confirmService.ask({
      title: `Close ${name}?`,
      message:
        'Members are sent the transcript and disconnected. The line moves to the archive, where it stays readable.',
      confirmLabel: 'Close line',
      danger: true,
    });
    if (!ok) return;
    this.busy.set('close');
    try {
      await this.api.closeChannel(name);
      this.selection.set({ kind: 'none' });
      this.messages.set([]);
      await this.refresh();
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to close the line.');
    } finally {
      this.busy.set(null);
    }
  }

  protected nonMembers(channel: ChannelSummary): AgentSummary[] {
    return this.agents().filter((a) => !channel.members.includes(a.name));
  }

  protected async addMember(channel: string, agent: string): Promise<void> {
    this.busy.set(`add:${agent}`);
    try {
      await this.api.addChannelMembers(channel, [agent]);
      await this.refresh();
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to patch the agent in.');
    } finally {
      this.busy.set(null);
    }
  }

  protected async removeMember(channel: string, agent: string): Promise<void> {
    const ok = await this.confirmService.ask({
      title: `Unpatch ${agent}?`,
      message: `${agent} is dropped from ${channel} and stops receiving it. The line stays open for everyone else.`,
      confirmLabel: 'Unpatch',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(`remove:${agent}`);
    try {
      await this.api.removeChannelMember(channel, agent);
      await this.refresh();
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to unpatch the agent.');
    } finally {
      this.busy.set(null);
    }
  }

  // --------------------------------------------------------- agent actions

  protected readonly renamingAgent = signal<string | null>(null);
  protected readonly renameValue = signal('');
  protected readonly issuedToken = signal<{ agent: string; token: string } | null>(null);

  protected startRename(agent: AgentSummary): void {
    this.renamingAgent.set(agent.name);
    this.renameValue.set(agent.name);
  }

  protected async saveRename(current: string): Promise<void> {
    const next = this.renameValue().trim();
    if (next.length === 0 || next === current) {
      this.renamingAgent.set(null);
      return;
    }
    this.busy.set(`rename:${current}`);
    try {
      await this.api.renameAgent(current, next);
      this.renamingAgent.set(null);
      await this.refresh();
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to rename the agent.');
    } finally {
      this.busy.set(null);
    }
  }

  protected async reissue(name: string): Promise<void> {
    const ok = await this.confirmService.ask({
      title: `Reissue ${name}'s token?`,
      message:
        'The old token stops working immediately. The agent keeps its name, channels and history — paste it the new token and it recovers.',
      confirmLabel: 'Reissue',
    });
    if (!ok) return;
    this.busy.set(`reissue:${name}`);
    try {
      const result = await this.api.reissueAgentToken(name);
      this.issuedToken.set({ agent: name, token: result.token });
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to reissue the token.');
    } finally {
      this.busy.set(null);
    }
  }

  protected async deleteAgent(name: string): Promise<void> {
    const ok = await this.confirmService.ask({
      title: `Delete ${name}?`,
      message:
        'The identity is removed and its name comes free immediately. Messages it already sent stay in the record under this name.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(`delete:${name}`);
    try {
      await this.api.deleteAgent(name);
      await this.refresh();
    } catch (err) {
      this.loadError.set(err instanceof ApiError ? err.message : 'Failed to delete the agent.');
    } finally {
      this.busy.set(null);
    }
  }

  // ------------------------------------------------------- patch requests

  protected async approvePatch(id: number): Promise<void> {
    this.busy.set(`patch:${id}`);
    try {
      await this.api.approvePatchRequest(id);
      await this.refresh();
      if (this.patchRequests().length === 0) this.showPatchRequests.set(false);
    } finally {
      this.busy.set(null);
    }
  }

  protected async denyPatch(id: number): Promise<void> {
    this.busy.set(`patch:${id}`);
    try {
      await this.api.denyPatchRequest(id);
      await this.refresh();
      if (this.patchRequests().length === 0) this.showPatchRequests.set(false);
    } finally {
      this.busy.set(null);
    }
  }

  // -------------------------------------------------------------- helpers

  protected agentByName(name: string): AgentSummary | undefined {
    return this.agents().find((a) => a.name === name);
  }

  protected memberPresence(channel: ChannelSummary, name: string): boolean {
    return channel.presence?.find((p) => p.name === name)?.connected ?? false;
  }

  protected lastSeen(channel: ChannelSummary, name: string): string | null {
    return channel.presence?.find((p) => p.name === name)?.last_seen_at ?? null;
  }

  /** A line is "live" when at least one of its members has a receive path. */
  protected anyConnected(channel: ChannelSummary): boolean {
    return (channel.presence ?? []).some((p) => p.connected);
  }

  protected onlineCount(): number {
    return this.agents().filter((a) => a.connected).length;
  }
}
