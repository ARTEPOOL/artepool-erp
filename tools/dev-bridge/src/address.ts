/**
 * The server address typed on the "enroll this PC" screen (the Rust layer applies the same rule).
 */

/** The default API port on the Main Server (architecture §2). */
export const DEFAULT_SERVER_PORT = 3100;

/**
 * What a person typed as the server address → `https://host:port`. Only HTTPS; no path, user
 * name or query. Returns null when it cannot be understood.
 */
export function serverUrlFrom(address: string): string | null {
  const text = address.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (!url.hostname) return null;
  const port = url.port || String(DEFAULT_SERVER_PORT);
  return `https://${url.hostname}:${port}`;
}
