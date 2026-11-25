/** Lowercases and strips accents one UTF-16 unit at a time, so the folded string has the same length as the original. */
export function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    out += (ch.normalize('NFD')[0] ?? ch).toLowerCase()[0] ?? ch;
  }
  return out;
}

export interface ParsedQuery {
  /** Single words (folded), each matched as a prefix. */
  words: string[];
  /** Quoted phrases (folded). */
  phrases: string[];
  /** MySQL BOOLEAN MODE expression, or null when nothing searchable was typed. */
  boolean: string | null;
}

/** InnoDB ignores tokens shorter than innodb_ft_min_token_size (set to 2 in docker-compose). */
const MIN_TOKEN = 2;
const MAX_TERMS = 12;

/**
 * Turns what a person typed into a BOOLEAN MODE expression that cannot be abused: every
 * operator character is stripped, so "+ - * ( ) < > ~ @ \"" in the input cannot change the
 * query's structure. Every word is required (AND) and matches as a prefix, so typing "acen"
 * finds "acentuação" as you type.
 */
export function parseSearchQuery(input: string): ParsedQuery {
  const phrases: string[] = [];
  const withoutPhrases = input.replace(/"([^"]*)"/g, (_m, p: string) => {
    const phrase = words(p).join(' ');
    if (phrase) phrases.push(phrase);
    return ' ';
  });

  const ws = words(withoutPhrases).slice(0, MAX_TERMS);
  const parts = [...phrases.slice(0, MAX_TERMS).map((p) => `+"${p}"`), ...ws.map((w) => `+${w}*`)];
  return { words: ws, phrases, boolean: parts.length ? parts.join(' ') : null };
}

/** Letters and digits only (any script); everything else, operators included, is a separator. */
function words(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= MIN_TOKEN);
}

const SNIPPET_RADIUS = 80;

/**
 * An excerpt around the first match with every match wrapped in [[ ]]. Matching is done on the
 * folded text, which has the same length as the original, so indices carry over exactly.
 */
export function buildSnippet(text: string, query: ParsedQuery): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const folded = fold(flat);
  const spans: [number, number][] = [];

  for (const needle of [...query.phrases, ...query.words]) {
    for (let from = 0; ; ) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      // A word match extends to the end of the word (prefix search); a phrase ends where it ends.
      let end = at + needle.length;
      if (!needle.includes(' ')) while (end < folded.length && /[\p{L}\p{N}]/u.test(folded[end]!)) end++;
      spans.push([at, end]);
      from = end;
    }
  }
  if (!spans.length) return flat.slice(0, SNIPPET_RADIUS * 2) + (flat.length > SNIPPET_RADIUS * 2 ? '…' : '');

  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }

  const start = Math.max(0, merged[0]![0] - SNIPPET_RADIUS);
  const stop = Math.min(flat.length, merged[0]![1] + SNIPPET_RADIUS);
  let out = '';
  let cursor = start;
  for (const [a, b] of merged) {
    if (a >= stop) break;
    if (b <= start) continue;
    const from = Math.max(a, start);
    const to = Math.min(b, stop);
    out += flat.slice(cursor, from) + '[[' + flat.slice(from, to) + ']]';
    cursor = to;
  }
  out += flat.slice(cursor, stop);
  return (start > 0 ? '…' : '') + out + (stop < flat.length ? '…' : '');
}

/** How many of the query's words/phrases occur in the title (used to rank title hits first). */
export function titleHits(title: string, query: ParsedQuery): number {
  const folded = fold(title);
  return [...query.phrases, ...query.words].filter((n) => folded.includes(n)).length;
}
