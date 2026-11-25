/**
 * Where the API lives. The build step (scripts/configure-web.mjs) writes `config.json` next to index.html:
 *   { "apiUrl": "" }                      same origin as the website (the default)
 *   { "apiUrl": "https://api.example.com" }
 * Whoever deploys the site can edit that file without rebuilding. It is read once, before the app starts.
 */
const CACHE_KEY = 'notes.apiUrl';

let base = '';

/** The API origin (and optional path) without a trailing slash, or '' when it is the website's own origin. */
export const apiBase = (): string => base;

/** Absolute address for something the browser fetches by itself (img/video src, download links). `path` starts with '/'. */
export const apiUrl = (path: string): string => base + path;

/** Accepts only http(s) addresses; anything else means "same origin". */
export function normaliseApiUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function remember(value: string): void {
  try {
    localStorage.setItem(CACHE_KEY, value);
  } catch {
    /* storage unavailable */
  }
}

function remembered(): string {
  try {
    return normaliseApiUrl(localStorage.getItem(CACHE_KEY));
  } catch {
    return '';
  }
}

/**
 * Reads config.json (never from a cache) and remembers the answer, so the app still starts offline.
 * Resolution: config.json, then the last value seen on this device, then same origin.
 */
export async function loadApiConfig(): Promise<void> {
  try {
    const res = await fetch(new URL('config.json', document.baseURI), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`config.json: ${res.status}`);
    const body: unknown = await res.json();
    base = normaliseApiUrl((body as { apiUrl?: unknown } | null)?.apiUrl);
    remember(base);
  } catch {
    // Offline, a server without the file, or an unreadable file. The service worker answers a missing network with an error too.
    base = remembered();
  }
}

/** For tests and the rare caller that already knows the answer. */
export function setApiBase(value: string): void {
  base = normaliseApiUrl(value);
}
