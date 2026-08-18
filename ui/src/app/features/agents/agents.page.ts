import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import type { AgentSummary } from '../../core/api.models';
import { ConfigService } from '../../core/config.service';
import { startPolling } from '../../core/polling';
import { BootstrapBlock } from '../../shared/bootstrap-block/bootstrap-block';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

interface IssuedToken {
  agentName: string;
  token: string;
  kind: 'registered' | 'reissued';
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

  protected readonly agents = signal<AgentSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly newAgentName = signal('');
  protected readonly registering = signal(false);
  protected readonly registerError = signal<string | null>(null);

  protected readonly issuedToken = signal<IssuedToken | null>(null);
  protected readonly reissuingName = signal<string | null>(null);
  protected readonly deletingName = signal<string | null>(null);

  private stopPolling?: () => void;

  ngOnInit(): void {
    void this.refresh();
    this.stopPolling = startPolling(() => void this.refresh());
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
  }

  protected get advertisedUrls(): string[] {
    const state = this.configService.state();
    return state.status === 'ready' ? state.config.advertisedUrls : [];
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

  protected async register(): Promise<void> {
    const name = this.newAgentName().trim();
    if (!name) return;
    this.registering.set(true);
    this.registerError.set(null);
    try {
      const res = await this.api.registerAgent(name);
      this.issuedToken.set({ agentName: res.name, token: res.token, kind: 'registered' });
      this.newAgentName.set('');
      await this.refresh();
    } catch (err) {
      this.registerError.set(err instanceof ApiError ? err.message : 'Failed to register agent.');
    } finally {
      this.registering.set(false);
    }
  }

  protected async deleteAgent(name: string): Promise<void> {
    if (
      !confirm(
        `Delete agent "${name}"? Its token stops working immediately. ` +
          `If it never sent a message the name is freed; otherwise the name stays retired so history keeps its attribution. ` +
          `Agents in open channels can't be deleted — close their channels first.`,
      )
    ) {
      return;
    }
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
    if (!confirm(`Reissue the token for "${name}"? The old token stops working immediately.`)) {
      return;
    }
    this.reissuingName.set(name);
    try {
      const res = await this.api.reissueAgentToken(name);
      this.issuedToken.set({ agentName: res.name, token: res.token, kind: 'reissued' });
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : `Failed to reissue token for ${name}.`);
    } finally {
      this.reissuingName.set(null);
    }
  }

  protected dismissIssuedToken(): void {
    this.issuedToken.set(null);
  }
}
