import { Component, Input, signal } from '@angular/core';

interface Variant {
  url: string;
  text: string;
  copied: boolean;
}

/**
 * Renders the one-time bootstrap block (SPEC.md §4 / ARCHITECTURE.md ui/),
 * one variant per advertisedUrls entry, each with its own copy button:
 *
 *   SWITCHBOARD
 *   url:    <advertised url>
 *   agent:  <name>
 *   token:  <plaintext token>
 *
 * The plaintext token only ever exists in memory for the caller's session —
 * this component does not persist it anywhere.
 */
@Component({
  selector: 'app-bootstrap-block',
  templateUrl: './bootstrap-block.html',
  styleUrl: './bootstrap-block.css',
})
export class BootstrapBlock {
  private _agentName = '';
  private _token = '';
  private _advertisedUrls: string[] = [];

  protected variants = signal<Variant[]>([]);

  @Input() set agentName(value: string) {
    this._agentName = value;
    this.rebuild();
  }
  @Input() set token(value: string) {
    this._token = value;
    this.rebuild();
  }
  @Input() set advertisedUrls(value: string[]) {
    this._advertisedUrls = value ?? [];
    this.rebuild();
  }

  private rebuild(): void {
    const urls = this._advertisedUrls.length > 0 ? this._advertisedUrls : [''];
    this.variants.set(
      urls.map((url) => ({
        url,
        text: `SWITCHBOARD\nurl:    ${url}\nagent:  ${this._agentName}\ntoken:  ${this._token}`,
        copied: false,
      })),
    );
  }

  protected async copy(variant: Variant): Promise<void> {
    try {
      await navigator.clipboard.writeText(variant.text);
    } catch {
      // Clipboard API unavailable (insecure context, permissions) — fall
      // back to a manual-select textarea trick.
      const el = document.createElement('textarea');
      el.value = variant.text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    this.variants.update((list) =>
      list.map((v) => (v.url === variant.url ? { ...v, copied: true } : v)),
    );
    setTimeout(() => {
      this.variants.update((list) =>
        list.map((v) => (v.url === variant.url ? { ...v, copied: false } : v)),
      );
    }, 1500);
  }
}
