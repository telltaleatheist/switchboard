import { Component, Input, signal } from '@angular/core';

interface Variant {
  url: string;
  text: string;
  copied: boolean;
}

/**
 * Renders the universal bootstrap block (ARCHITECTURE.md ui/): the SAME
 * block for every agent — no per-agent identity in it. An agent pastes it
 * once, hits `POST /v1/join` with the join key, and picks its own name:
 *
 *   SWITCHBOARD
 *   url:   <advertised url>
 *   join:  <join key>
 *
 * One variant per advertisedUrls entry, each with its own copy button.
 */
@Component({
  selector: 'app-bootstrap-block',
  templateUrl: './bootstrap-block.html',
  styleUrl: './bootstrap-block.css',
})
export class BootstrapBlock {
  private _joinKey = '';
  private _advertisedUrls: string[] = [];

  protected variants = signal<Variant[]>([]);

  @Input() set joinKey(value: string) {
    this._joinKey = value;
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
        text: `SWITCHBOARD\nurl:   ${url}\njoin:  ${this._joinKey}`,
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
