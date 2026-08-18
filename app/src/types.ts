/**
 * Shared types for the Electron main process, the preload bridge, and (via
 * the ambient `Window` augmentation below) whatever renderer code consumes
 * `window.switchboard`.
 */

/** Config surfaced to the renderer via `window.switchboard.getConfig()`. */
export interface SwitchboardConfig {
  /** http://127.0.0.1:<port> — for the operator console's own API calls. */
  baseUrl: string;
  /** The ephemeral, per-boot operator token minted by the server. */
  operatorToken: string;
  /**
   * Ranked `http://<ip>:<port>` routes to this switchboard, literal IPs
   * only. The FIRST entry is the primary outbound IPv4 — the one the
   * console's join block shows; the rest (other interfaces, loopback last)
   * sit behind an address picker for machines that can't reach the primary.
   */
  advertisedUrls: string[];
}

declare global {
  interface Window {
    switchboard: {
      getConfig(): Promise<SwitchboardConfig>;
    };
  }
}
