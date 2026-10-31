/**
 * Normalizes the app's page URL for the IPC sender check: parsed, without the
 * fragment. The Vite dev server URL has no trailing slash
 * ("http://localhost:5173") while the loaded frame reports one; a raw string
 * comparison rejected every call in `npm start`.
 */
export function normalizeAppUrl(u: string): string | null {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch {
    return null;
  }
}
