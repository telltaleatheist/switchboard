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
   * http://<hostname-or-LAN-IP>:<port> for every non-internal address this
   * machine has, so bootstrap-block text pasted into an agent session can
   * pick whichever URL is reachable from that agent's machine.
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
