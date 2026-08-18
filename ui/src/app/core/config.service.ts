import { Injectable, signal } from '@angular/core';

/** Config surfaced by the Electron preload (app/ owns the real implementation). */
export interface SwitchboardConfig {
  baseUrl: string;
  operatorToken: string;
  advertisedUrls: string[];
}

declare global {
  interface Window {
    /** Present only inside the Electron shell; absent in plain-browser dev. */
    switchboard?: {
      getConfig(): Promise<SwitchboardConfig>;
    };
  }
}

const LS_BASE_URL = 'switchboard.baseUrl';
const LS_TOKEN = 'switchboard.operatorToken';

export type ConfigState =
  | { status: 'loading' }
  | { status: 'ready'; config: SwitchboardConfig; devMode: boolean }
  | { status: 'error'; message: string };

/**
 * Resolves {baseUrl, operatorToken, advertisedUrls} from window.switchboard
 * (Electron preload) or, when absent, from localStorage dev-mode overrides.
 * Missing config of either kind is a visible blocking error — never a silent
 * blank page (per ARCHITECTURE.md ui/ contract).
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  readonly state = signal<ConfigState>({ status: 'loading' });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set({ status: 'loading' });
    try {
      if (window.switchboard?.getConfig) {
        const config = await window.switchboard.getConfig();
        this.assertComplete(config);
        this.state.set({ status: 'ready', config, devMode: false });
        return;
      }

      const baseUrl = localStorage.getItem(LS_BASE_URL);
      const operatorToken = localStorage.getItem(LS_TOKEN);
      if (!baseUrl || !operatorToken) {
        this.state.set({
          status: 'error',
          message:
            'No window.switchboard bridge (not running inside the Electron shell) and no ' +
            'dev-mode config in localStorage. Set switchboard.baseUrl and ' +
            'switchboard.operatorToken below to continue.',
        });
        return;
      }
      const config: SwitchboardConfig = {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        operatorToken,
        advertisedUrls: [baseUrl.replace(/\/+$/, '')],
      };
      this.state.set({ status: 'ready', config, devMode: true });
    } catch (err) {
      this.state.set({
        status: 'error',
        message: err instanceof Error ? err.message : 'Unknown error loading config.',
      });
    }
  }

  /** Used by the dev-mode config form when window.switchboard is absent. */
  setDevConfig(baseUrl: string, operatorToken: string): void {
    localStorage.setItem(LS_BASE_URL, baseUrl.trim().replace(/\/+$/, ''));
    localStorage.setItem(LS_TOKEN, operatorToken.trim());
    void this.load();
  }

  private assertComplete(config: SwitchboardConfig): void {
    if (!config || !config.baseUrl || !config.operatorToken) {
      throw new Error('window.switchboard.getConfig() returned an incomplete config.');
    }
  }
}
