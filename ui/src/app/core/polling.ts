/**
 * Shared "light polling" strategy for list panes (ARCHITECTURE.md ui/:
 * "Poll-refresh lists lightly (10 s) + refresh on window focus").
 *
 * Usage (in a component's ngOnInit / ngOnDestroy):
 *   private stopPolling?: () => void;
 *   ngOnInit() { this.stopPolling = startPolling(() => this.refresh()); }
 *   ngOnDestroy() { this.stopPolling?.(); }
 */
export const POLL_INTERVAL_MS = 10_000;

export function startPolling(tick: () => void, intervalMs = POLL_INTERVAL_MS): () => void {
  const intervalId = setInterval(tick, intervalMs);
  const onFocus = () => tick();
  window.addEventListener('focus', onFocus);
  return () => {
    clearInterval(intervalId);
    window.removeEventListener('focus', onFocus);
  };
}
