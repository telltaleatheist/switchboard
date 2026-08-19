import { Component, Input, computed, signal } from '@angular/core';
import { copyText } from '../clipboard';

/**
 * Renders THE bootstrap block (ARCHITECTURE.md ui/): one universal block,
 * one URL — no per-agent identity, no variant list. Which address goes in
 * is the page's decision (the console defaults to the machine's primary
 * IP and offers alternates behind a picker):
 *
 *   SWITCHBOARD
 *   url:   <url>
 *   join:  <join key>
 */
@Component({
  selector: 'app-bootstrap-block',
  templateUrl: './bootstrap-block.html',
  styleUrl: './bootstrap-block.css',
})
export class BootstrapBlock {
  private readonly _url = signal('');
  private readonly _joinKey = signal('');

  protected readonly copied = signal(false);
  protected readonly text = computed(
    () => `SWITCHBOARD\nurl:   ${this._url()}\njoin:  ${this._joinKey()}`,
  );
  protected readonly url = computed(() => this._url());

  @Input({ alias: 'url' }) set urlInput(value: string) {
    this._url.set(value ?? '');
  }
  @Input() set joinKey(value: string) {
    this._joinKey.set(value ?? '');
  }

  protected async copy(): Promise<void> {
    await copyText(this.text());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
