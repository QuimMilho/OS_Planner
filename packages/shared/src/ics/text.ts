// Text rules of iCalendar (RFC 5545): line folding, value escaping, and turning the HTML some services put in descriptions into plain text.

/** Joins folded lines (a line that starts with a space or tab continues the one before) and splits into content lines. */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length)
      out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

/** Folds one content line to 75 octets, never inside a UTF-8 sequence. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74;
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export const escapeText = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');

export const unescapeText = (s: string): string =>
  s.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#')) {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * Descriptions from other services may be HTML. Anything that looks like it becomes plain text with links and lists kept as Markdown;
 * scripts, styles and every other tag are dropped. Plain text passes through untouched.
 */
export function plainText(input: string): string {
  let s = input.replace(/\r\n?/g, '\n');
  if (/<\/?[a-z][^>]*>/i.test(s)) {
    s = s
      .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(
        /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
        (_m, a: string | undefined, b: string | undefined, label: string) => {
          const href = decodeEntities((a ?? b ?? '').trim());
          const text = label.replace(/<[^>]*>/g, '').trim();
          return /^https?:\/\//i.test(href)
            ? text && text !== href
              ? `[${text}](${href})`
              : href
            : text;
        },
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|h[1-6]|ul|ol|tr|li|table)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '');
    s = decodeEntities(s);
  }
  // Control characters (except tab and newline) have no place in a description.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A single line of text (a title or a place): plain, one line, no control characters. */
export const oneLine = (input: string): string => plainText(input).replace(/\s+/g, ' ').trim();
