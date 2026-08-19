import { Component, Input, computed, signal } from '@angular/core';
import { copyText } from '../clipboard';

type Platform = 'unix' | 'windows';

/**
 * First-run instructions: where the switchboard skill file goes on an agent
 * machine, and the one command that puts it there.
 *
 * The install command pulls from this server's own `GET /v1/skill`, so the
 * operator never has to find the file — whatever machine can reach the
 * switchboard can also fetch its skill. `<url>` is the same address the join
 * block is showing, so both halves of setup are copied from one place.
 */
@Component({
  selector: 'app-skill-setup',
  templateUrl: './skill-setup.html',
  styleUrl: './skill-setup.css',
})
export class SkillSetup {
  private readonly _url = signal('');

  /** Which tab is showing; defaults to this console's own platform. */
  protected readonly platform = signal<Platform>(
    navigator.userAgent.includes('Windows') ? 'windows' : 'unix',
  );
  protected readonly copied = signal(false);

  @Input({ alias: 'url' }) set urlInput(value: string) {
    this._url.set(value ?? '');
  }

  protected readonly destination = computed(() =>
    this.platform() === 'windows'
      ? '%USERPROFILE%\\.claude\\skills\\switchboard\\SKILL.md'
      : '~/.claude/skills/switchboard/SKILL.md',
  );

  protected readonly command = computed(() =>
    this.platform() === 'windows'
      ? `New-Item -ItemType Directory -Force "$env:USERPROFILE\\.claude\\skills\\switchboard" | Out-Null; ` +
        `curl.exe -fsSL ${this._url()}/v1/skill -o "$env:USERPROFILE\\.claude\\skills\\switchboard\\SKILL.md"`
      : `mkdir -p ~/.claude/skills/switchboard && curl -fsSL ${this._url()}/v1/skill -o ~/.claude/skills/switchboard/SKILL.md`,
  );

  protected select(platform: Platform): void {
    this.platform.set(platform);
    this.copied.set(false);
  }

  protected async copy(): Promise<void> {
    await copyText(this.command());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
