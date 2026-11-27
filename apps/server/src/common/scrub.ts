/**
 * What must never reach a log line (phase 17): access and media tokens, the secrets in feed, link and invite addresses, the query
 * string of any address (media tokens, link sessions, invite tokens travel there), push endpoints (a secret of the device), and
 * passwords that slipped into a message. Applied to every line the server logs (AppLogger) and to the path of each request.
 */
const RULES: [RegExp, string][] = [
  // JSON Web Tokens (access, media, LiveKit)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]'],
  // the query string of an address: everything after the "?"
  [/(\bhttps?:\/\/[^\s"'?#]*|(?<![\w/])\/[\w./-]*)\?[^\s"'#]*/gi, '$1?[redacted]'],
  // secrets in paths: feeds, share links, invites, the public reader
  [/\/(api\/feeds|api\/links|links|s|invite)\/[A-Za-z0-9_-]{16,}/g, '/$1/[secret]'],
  // push services: the whole address of a device is its secret
  [
    /https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]*\.notify\.windows\.com|web\.push\.apple\.com)\/[^\s"']*/gi,
    'https://$1/[device]',
  ],
  // key=value pairs that carry secrets
  [
    /\b(password|passwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b|\[)[^\s"',;&]+/gi,
    '$1$2[redacted]',
  ],
];

export function scrub(text: string): string {
  let out = text;
  for (const [re, by] of RULES) out = out.replace(re, by);
  return out;
}

/** The same for anything a logger may be handed: strings, errors (message and stack), and plain values. */
export function scrubAny<T>(value: T): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (value instanceof Error) {
    const copy = new Error(scrub(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? scrub(value.stack) : undefined;
    return copy as T;
  }
  return value;
}
