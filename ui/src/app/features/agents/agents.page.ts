import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { AgentSummary } from '../../core/api.models';
import { ConfigService } from '../../core/config.service';
import { ConfirmService } from '../../core/confirm.service';
import { startPolling } from '../../core/polling';
import { BootstrapBlock } from '../../shared/bootstrap-block/bootstrap-block';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

interface IssuedToken {
  agentName: string;
  token: string;
}

@Component({
  selector: 'app-agents-page',
  imports: [FormsModule, BootstrapBlock, RelativeTimePipe],
  templateUrl: './agents.page.html',
  styleUrl: './agents.page.css',
})
export class AgentsPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly configService = inject(ConfigService);
  private readonly confirmService = inject(ConfirmService);

  protected readonly agents = signal<AgentSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly joinKey = signal<string | null>(null);
  protected readonly joinKeyError = signal<string | null>(null);
  protected readonly rotating = signal(false);
  /** Address override for the join block; null = the default (hostname if set, else primary IP). */
  protected readonly selectedUrl = signal<string | null>(null);

  /** Operator-configured DNS name leading the join block (null = primary IP). */
  protected readonly advertisedHost = signal<string | null>(null);
  protected readonly editingHost = signal(false);
  protected readonly hostValue = signal('');
  protected readonly hostError = signal<string | null>(null);
  protected readonly savingHost = signal(false);

  protected readonly issuedToken = signal<IssuedToken | null>(null);
  protected readonly reissuingName = signal<string | null>(null);
  protected readonly deletingName = signal<string | null>(null);

  protected readonly editingName = signal<string | null>(null);
  protected readonly editValue = signal('');
  protected readonly renameError = signal<string | null>(null);
  protected readonly savingRename = signal(false);

  private stopPolling?: () => void;

  ngOnInit(): void {
    void this.refresh();
    void this.loadJoinKey();
    this.stopPolling = startPolling(() => void this.refresh());
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
  }

  protected get advertisedUrls(): string[] {
    const state = this.configService.state();
    return state.status === 'ready' ? state.config.advertisedUrls : [];
  }

  /**
   * Every route the block can carry: the configured DNS name first (it
   * survives IP churn and reads better than an address), then the ranked
   * IPs from the app config.
   */
  protected urlOptions(): string[] {
    const host = this.advertisedHost();
    const options = host ? [`http://${host}:${this.serverPort()}`] : [];
    return [...options, ...this.advertisedUrls];
  }

  /** The URL shown in the join block: the picker's choice, else the default. */
  protected effectiveUrl(): string {
    const options = this.urlOptions();
    const chosen = this.selectedUrl();
    if (chosen !== null && options.includes(chosen)) return chosen;
    return options[0] ?? '';
  }

  private serverPort(): string {
    const first = this.advertisedUrls[0];
    const match = first ? /:(\d+)$/.exec(first) : null;
    return match ? (match[1] as string) : '4400';
  }

  protected async refresh(): Promise<void> {
    try {
      const { agents } = await this.api.listAgents();
      this.agents.set(agents);
      this.error.set(null);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Failed to load agents.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadJoinKey(): Promise<void> {
    try {
      const [{ join_key }, { host }] = await Promise.all([
        this.api.getJoinKey(),
        this.api.getAdvertisedHost(),
      ]);
      this.joinKey.set(join_key);
      this.advertisedHost.set(host);
      this.joinKeyError.set(null);
    } catch (err) {
      this.joinKeyError.set(err instanceof ApiError ? err.message : 'Failed to load the join key.');
    }
  }

  protected startEditHost(): void {
    this.hostValue.set(this.advertisedHost() ?? '');
    this.hostError.set(null);
    this.editingHost.set(true);
  }

  protected cancelEditHost(): void {
    this.editingHost.set(false);
    this.hostError.set(null);
  }

  protected async saveHost(): Promise<void> {
    const value = this.hostValue().trim();
    this.savingHost.set(true);
    this.hostError.set(null);
    try {
      const { host } = await this.api.setAdvertisedHost(value.length === 0 ? null : value);
      this.advertisedHost.set(host);
      this.selectedUrl.set(null);
      this.editingHost.set(false);
    } catch (err) {
      this.hostError.set(err instanceof ApiError ? err.message : 'Failed to save the address.');
    } finally {
      this.savingHost.set(false);
    }
  }

  protected async rotateJoinKey(): Promise<void> {
    const ok = await this.confirmService.ask({
      title: 'Rotate the join key?',
      message:
        'The old paste block stops working immediately — anyone who hasn\'t joined yet with it will ' +
        'need the new block. Agents that already joined keep working; they hold their own tokens.',
      confirmLabel: 'Rotate key',
      danger: true,
    });
    if (!ok) return;
    this.rotating.set(true);
    try {
      const { join_key } = await this.api.rotateJoinKey();
      this.joinKey.set(join_key);
      this.joinKeyError.set(null);
    } catch (err) {
      this.joinKeyError.set(err instanceof ApiError ? err.message : 'Failed to rotate the join key.');
    } finally {
      this.rotating.set(false);
    }
  }

  protected async deleteAgent(name: string): Promise<void> {
    const ok = await this.confirmService.ask({
      title: `Delete agent "${name}"?`,
      message:
        `Its token stops working immediately, it is removed from any open channels (they stay open for everyone else), ` +
        `and the name is freed for reuse. Message history keeps its attribution.`,
      confirmLabel: 'Delete agent',
      danger: true,
    });
    if (!ok) return;
    this.deletingName.set(name);
    try {
      await this.api.deleteAgent(name);
      await this.refresh();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : `Failed to delete agent ${name}.`);
    } finally {
      this.deletingName.set(null);
    }
  }

  protected async reissue(name: string): Promise<void> {
    const ok = await this.confirmService.ask({
      title: `Reissue token for "${name}"?`,
      message: 'The old token stops working immediately.',
      confirmLabel: 'Reissue token',
    });
    if (!ok) return;
    this.reissuingName.set(name);
    try {
      const res = await this.api.reissueAgentToken(name);
      this.issuedToken.set({ agentName: res.name, token: res.token });
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : `Failed to reissue token for ${name}.`);
    } finally {
      this.reissuingName.set(null);
    }
  }

  protected dismissIssuedToken(): void {
    this.issuedToken.set(null);
  }

  protected startRename(agent: AgentSummary): void {
    this.editingName.set(agent.name);
    this.editValue.set(agent.name);
    this.renameError.set(null);
  }

  protected cancelRename(): void {
    this.editingName.set(null);
    this.editValue.set('');
    this.renameError.set(null);
  }

  protected async saveRename(currentName: string): Promise<void> {
    const newName = this.editValue().trim();
    if (!newName) {
      this.renameError.set('Name is required.');
      return;
    }
    if (newName === currentName) {
      this.cancelRename();
      return;
    }
    this.savingRename.set(true);
    this.renameError.set(null);
    try {
      await this.api.renameAgent(currentName, newName);
      this.editingName.set(null);
      this.editValue.set('');
      await this.refresh();
    } catch (err) {
      this.renameError.set(err instanceof ApiError ? err.message : `Failed to rename ${currentName}.`);
    } finally {
      this.savingRename.set(false);
    }
  }
}
