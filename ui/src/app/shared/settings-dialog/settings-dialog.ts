import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiError, ApiService } from '../../core/api.service';
import { ConfigService } from '../../core/config.service';
import { ConfirmService } from '../../core/confirm.service';
import { BootstrapBlock } from '../bootstrap-block/bootstrap-block';
import { SkillSetup } from '../skill-setup/skill-setup';

export type SettingsTab = 'welcome' | 'address' | 'join' | 'archives';

/**
 * Everything you configure rather than operate: the welcome agents are handed,
 * the address the join block leads with, the join key itself, and archive
 * housekeeping. All of it is monthly-or-rarer work, so it lives behind one
 * dialog instead of taking permanent space beside the channels you read.
 */
@Component({
  selector: 'app-settings-dialog',
  imports: [FormsModule, BootstrapBlock, SkillSetup],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.css',
})
export class SettingsDialog {
  private readonly api = inject(ApiService);
  private readonly configService = inject(ConfigService);
  private readonly confirmService = inject(ConfirmService);

  protected readonly tab = signal<SettingsTab>('welcome');
  @Input({ alias: 'tab' }) set tabInput(value: SettingsTab) {
    this.tab.set(value);
    void this.load();
  }
  @Output() readonly closed = new EventEmitter<void>();

  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly savedNote = signal<string | null>(null);

  // welcome
  protected readonly welcome = signal('');
  protected readonly welcomeIsDefault = signal(true);
  // address
  protected readonly advertisedHost = signal<string | null>(null);
  protected readonly hostDraft = signal('');
  protected readonly selectedUrl = signal<string | null>(null);
  // join key
  protected readonly joinKey = signal<string | null>(null);
  // archives
  protected readonly purgeDays = signal('30');
  protected readonly purgeResult = signal<string | null>(null);

  private loaded = false;

  protected async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const [welcome, host, key] = await Promise.all([
        this.api.getWelcome(),
        this.api.getAdvertisedHost(),
        this.api.getJoinKey(),
      ]);
      this.welcome.set(welcome.welcome);
      this.welcomeIsDefault.set(welcome.is_default);
      this.advertisedHost.set(host.host);
      this.hostDraft.set(host.host ?? '');
      this.joinKey.set(key.join_key);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Failed to load settings.');
    }
  }

  protected select(tab: SettingsTab): void {
    this.tab.set(tab);
    this.error.set(null);
    this.savedNote.set(null);
  }

  protected close(): void {
    this.closed.emit();
  }

  // ---- the machine's own routes, for the join block ----------------------

  protected advertisedUrls(): string[] {
    const state = this.configService.state();
    return state.status === 'ready' ? state.config.advertisedUrls : [];
  }

  protected urlOptions(): string[] {
    const host = this.advertisedHost();
    const port = /:(\d+)$/.exec(this.advertisedUrls()[0] ?? '')?.[1] ?? '4400';
    return [...(host ? [`http://${host}:${port}`] : []), ...this.advertisedUrls()];
  }

  protected effectiveUrl(): string {
    const options = this.urlOptions();
    const chosen = this.selectedUrl();
    return chosen !== null && options.includes(chosen) ? chosen : (options[0] ?? '');
  }

  // ---- saves --------------------------------------------------------------

  protected async saveWelcome(): Promise<void> {
    const text = this.welcome().trim();
    if (text.length === 0) {
      this.error.set('The welcome cannot be empty — restore the default instead.');
      return;
    }
    await this.run(async () => {
      const result = await this.api.setWelcome(text);
      this.welcome.set(result.welcome);
      this.welcomeIsDefault.set(result.is_default);
      this.savedNote.set('Saved — agents see it on their next join or recovery.');
    });
  }

  protected async restoreWelcome(): Promise<void> {
    const ok = await this.confirmService.ask({
      title: 'Restore the default welcome?',
      message: 'Your edited text is replaced by the built-in welcome.',
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      const result = await this.api.setWelcome(null);
      this.welcome.set(result.welcome);
      this.welcomeIsDefault.set(result.is_default);
      this.savedNote.set('Restored the built-in welcome.');
    });
  }

  protected async saveHost(): Promise<void> {
    const host = this.hostDraft().trim();
    await this.run(async () => {
      const result = await this.api.setAdvertisedHost(host.length === 0 ? null : host);
      this.advertisedHost.set(result.host);
      this.savedNote.set(
        result.host ? `Join blocks now lead with ${result.host}.` : 'Join blocks lead with the primary IP again.',
      );
    });
  }

  protected async rotateJoinKey(): Promise<void> {
    const ok = await this.confirmService.ask({
      title: 'Rotate the join key?',
      message:
        'The current key stops working immediately. Agents that already joined keep their own tokens and are unaffected.',
      confirmLabel: 'Rotate',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      const result = await this.api.rotateJoinKey();
      this.joinKey.set(result.join_key);
      this.savedNote.set('New key minted — the old one is dead.');
    });
  }

  protected async purge(): Promise<void> {
    const days = Number(this.purgeDays());
    if (!Number.isInteger(days) || days < 0) {
      this.error.set('Enter a whole number of days.');
      return;
    }
    const ok = await this.confirmService.ask({
      title: `Delete archives older than ${days} days?`,
      message: 'The transcripts are removed permanently. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.run(async () => {
      const result = await this.api.purge(days);
      this.purgeResult.set(`${result.deleted} archive${result.deleted === 1 ? '' : 's'} deleted.`);
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.savedNote.set(null);
    try {
      await work();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      this.saving.set(false);
    }
  }
}
