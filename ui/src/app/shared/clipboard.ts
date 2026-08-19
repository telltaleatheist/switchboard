/**
 * Copy text to the clipboard.
 *
 * The async Clipboard API is unavailable in some renderer contexts (insecure
 * origin, denied permission), so this falls back to the hidden-textarea
 * selection trick rather than failing silently — a copy button that does
 * nothing is worse than no copy button.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
}
