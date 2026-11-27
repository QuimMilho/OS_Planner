import { isSafeHref } from '../doc/validate';
import { matchMentionAt, MENTION_LIMITS, type MentionKind, type MentionsDto } from './mentions';

/**
 * Markdown for chat messages, turned into a small tree that a view draws with its own elements. The text of a message
 * never becomes markup: there is no HTML in the output, only text nodes and a fixed set of element kinds, so nothing a
 * person types can run script or load anything. Links are kept only when `isSafeHref` accepts them (the same rule as links
 * in notes); images are not supported and show as their text.
 *
 * Supported: **bold**, *italic* / _italic_, ~~strike~~, `code`, ```fenced code```, > quotes, - and 1. lists, # headings,
 * ---, [links](https://…), bare http(s) links, and \ to escape. A line break inside a paragraph is a line break.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'mention'; kind: MentionKind; id: string | null }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'ul'; items: Block[][] }
  | { t: 'ol'; start: number; items: Block[][] }
  | { t: 'code'; lang: string | null; v: string }
  | { t: 'hr' };

/** Nesting deeper than this is shown as plain text: it bounds the work for input made to be slow. */
const MAX_DEPTH = 6;
/** Longest text that is interpreted at all; the rest (chat messages are capped at 4000 anyway) is plain text. */
const MAX_INPUT = 20_000;

// ---------------------------------------------------------------- inline

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/u.test(ch);

/** Appends text, merging with a text node before it. */
function pushText(out: Inline[], v: string): void {
  if (!v) return;
  const last = out.at(-1);
  if (last?.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

/** Index of the closing `delim` for an opener at `from` (just after it), or -1. Content must not start or end with a space. */
function findClose(src: string, delim: string, from: number, budget: ScanBudget): number {
  if (isSpace(src[from])) return -1;
  for (let i = from + 1; i < src.length; i++) {
    // every unmatched opener scans to the end, so many of them make the work grow with the square of the text
    if (--budget.left < 0) return -1;
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '`') {
      // a code span inside protects its content from the search
      const end = src.indexOf('`', i + 1);
      if (end === -1) continue;
      i = end;
      continue;
    }
    if (src.startsWith(delim, i) && !isSpace(src[i - 1])) {
      // for a single * or _, a doubled one belongs to something else
      if (delim.length === 1 && (src[i + 1] === delim || src[i - 1] === delim)) continue;
      // in a longer run ("bold *and italic***") the last characters close this one and the first ones close what is inside
      let end = i;
      while (src[end] === delim[0]) end++;
      return end - i >= delim.length ? end - delim.length : i;
    }
  }
  return -1;
}

/** Characters that closing-delimiter searches may look at in one message; past it an opener is plain text. */
const SCAN_BUDGET = 400_000;
interface ScanBudget {
  left: number;
}

const BARE_URL_END = /[\s<>"'`]/u;

export function parseInline(
  src: string,
  depth = 0,
  budget: ScanBudget = { left: SCAN_BUDGET },
): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, src);
    return out;
  }
  let i = 0;
  outer: while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#>!<-]/.test(src[i + 1]!)) {
      pushText(out, src[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = src.indexOf(fence, i + run);
      if (end !== -1 && src[end + run] !== '`') {
        out.push({ t: 'code', v: src.slice(i + run, end).replace(/^ (.*) $/s, '$1') });
        i = end + run;
        continue;
      }
      pushText(out, fence);
      i += run;
      continue;
    }

    if (ch === '<') {
      const mention = matchMentionAt(src, i);
      if (mention) {
        out.push({ t: 'mention', kind: mention.kind, id: mention.id });
        i = mention.end;
        continue;
      }
    }

    if (ch === '!' && src[i + 1] === '[') {
      // images are not supported: the text stays, and the address is not followed
      pushText(out, '!');
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = findLabelEnd(src, i);
      if (close !== -1 && src[close + 1] === '(') {
        const hrefEnd = src.indexOf(')', close + 2);
        if (hrefEnd !== -1) {
          const raw = src.slice(close + 2, hrefEnd).trim();
          const href = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
          const label = parseInline(src.slice(i + 1, close), depth + 1, budget);
          // Only addresses without spaces or quotes, and only ones the notes accept as well, become links.
          if (href && !/[\s"'<>\\]/.test(href) && isSafeHref(href))
            out.push({ t: 'link', href, c: label });
          else for (const node of label) out.push(node);
          i = hrefEnd + 1;
          continue;
        }
      }
      pushText(out, '[');
      i++;
      continue;
    }

    if (
      (src.startsWith('http://', i) || src.startsWith('https://', i)) &&
      !isWordChar(src[i - 1])
    ) {
      let end = i;
      while (end < src.length && !BARE_URL_END.test(src[end]!)) end++;
      // trailing punctuation belongs to the sentence, not the address
      while (end > i && /[.,;:!?)\]}]/.test(src[end - 1]!)) end--;
      const href = src.slice(i, end);
      if (isSafeHref(href) && href.length > 'https://'.length) {
        out.push({ t: 'link', href, c: [{ t: 'text', v: href }] });
        i = end;
        continue;
      }
    }

    for (const [delim, t] of [
      ['**', 'strong'],
      ['~~', 'del'],
      ['*', 'em'],
      ['_', 'em'],
    ] as const) {
      if (!src.startsWith(delim, i)) continue;
      // _ inside a word (snake_case) is not emphasis
      if (delim === '_' && (isWordChar(src[i - 1]) || src[i + 1] === '_')) break;
      if (delim === '*' && src[i + 1] === '*') break;
      const close = findClose(src, delim, i + delim.length, budget);
      if (close === -1 || (delim === '_' && isWordChar(src[close + 1]))) break;
      out.push({ t, c: parseInline(src.slice(i + delim.length, close), depth + 1, budget) });
      i = close + delim.length;
      continue outer;
    }

    pushText(out, ch);
    i++;
  }
  return out;
}

/** The `]` that closes the `[` at `open`, skipping escapes and code spans; -1 when there is none. */
function findLabelEnd(src: string, open: number): number {
  let level = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end !== -1) i = end;
    } else if (ch === '[') level++;
    else if (ch === ']' && --level === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- blocks

/** A paragraph's lines joined with line breaks. */
function paragraph(lines: string[], depth: number): Block {
  const c: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) c.push({ t: 'br' });
    for (const node of parseInline(line.trim(), depth + 1)) c.push(node);
  });
  return { t: 'p', c };
}

const FENCE = /^ {0,3}(`{3,})\s*([\w+#.-]*)\s*$/;
const ULI = /^ {0,3}[-*+]\s+(.*)$/;
const OLI = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^ {0,3}(#{1,3})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) out.push(paragraph(para, depth));
    para = [];
  };
  if (depth > MAX_DEPTH) return [paragraph(lines, depth)];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      flush();
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^ {0,3}${fence[1]}\`*\\s*$`).test(lines[i]!); i++)
        body.push(lines[i]!);
      out.push({ t: 'code', lang: fence[2] ? fence[2].toLowerCase() : null, v: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      out.push({
        t: 'h',
        level: heading[1]!.length as 1 | 2 | 3,
        c: parseInline(heading[2]!, depth + 1),
      });
      continue;
    }
    if (HR.test(line)) {
      flush();
      out.push({ t: 'hr' });
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      flush();
      const inner: string[] = [];
      for (; i < lines.length && /^ {0,3}>/.test(lines[i]!); i++)
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
      i--;
      out.push({ t: 'quote', c: parseBlocks(inner, depth + 1) });
      continue;
    }

    const ul = ULI.exec(line);
    const ol = OLI.exec(line);
    if (ul || ol) {
      flush();
      const ordered = Boolean(ol);
      const items: string[][] = [];
      const start = ol ? Number(ol[1]) : 1;
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        const m = ordered ? OLI.exec(l) : ULI.exec(l);
        if (m) items.push([ordered ? m[2]! : m[1]!]);
        // an indented line continues the item above
        else if (items.length && /^ {2,}\S/.test(l)) items.at(-1)!.push(l.trim());
        else break;
      }
      i--;
      const parsed = items.map((item) => parseBlocks(item, depth + 1));
      out.push(ordered ? { t: 'ol', start, items: parsed } : { t: 'ul', items: parsed });
      continue;
    }

    para.push(line);
  }
  flush();
  return out;
}

/** The message as blocks. Text beyond MAX_INPUT characters is shown as it is, uninterpreted. */
export function parseChatMarkdown(src: string): Block[] {
  const head = src.slice(0, MAX_INPUT);
  const blocks = parseBlocks(head.replace(/\r\n?/g, '\n').split('\n'), 0);
  if (src.length > MAX_INPUT) blocks.push({ t: 'p', c: [{ t: 'text', v: src.slice(MAX_INPUT) }] });
  return blocks;
}

// ---------------------------------------------------------------- HTML (for places that need a string; the web app draws the tree itself)

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function inlineHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escapeHtml(n.v);
        case 'br':
          return '<br>';
        case 'code':
          return `<code>${escapeHtml(n.v)}</code>`;
        case 'mention':
          return `<span class="mention">${escapeHtml(mentionLabel(n))}</span>`;
        case 'link':
          return `<a href="${escapeHtml(n.href)}" rel="noopener noreferrer nofollow" target="_blank">${inlineHtml(n.c)}</a>`;
        default:
          return `<${n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 'del'}>${inlineHtml(n.c)}</${n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 'del'}>`;
      }
    })
    .join('');
}

function blockHtml(blocks: readonly Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'p':
          return `<p>${inlineHtml(b.c)}</p>`;
        case 'h':
          return `<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`;
        case 'quote':
          return `<blockquote>${blockHtml(b.c)}</blockquote>`;
        case 'ul':
          return `<ul>${b.items.map((item) => `<li>${blockHtml(item)}</li>`).join('')}</ul>`;
        case 'ol':
          return `<ol start="${b.start}">${b.items.map((item) => `<li>${blockHtml(item)}</li>`).join('')}</ol>`;
        case 'code':
          return `<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ''}>${escapeHtml(b.v)}</code></pre>`;
        case 'hr':
          return '<hr>';
      }
    })
    .join('');
}

/** The message as an HTML string made only of escaped text and the fixed elements above. */
export function chatMarkdownToHtml(src: string): string {
  return blockHtml(parseChatMarkdown(src));
}

/** The text of a message without its formatting (for notifications and previews). */
export function chatMarkdownToText(
  src: string,
  nameOf?: (kind: MentionKind, id: string | null) => string | undefined,
): string {
  const inline = (nodes: readonly Inline[]): string =>
    nodes
      .map((n) =>
        n.t === 'text' || n.t === 'code'
          ? n.v
          : n.t === 'br'
            ? ' '
            : n.t === 'mention'
              ? mentionLabel(n, nameOf)
              : inline(n.c),
      )
      .join('');
  const block = (b: Block): string => {
    switch (b.t) {
      case 'p':
      case 'h':
        return inline(b.c);
      case 'quote':
        return b.c.map(block).join(' ');
      case 'ul':
      case 'ol':
        return b.items.map((item) => item.map(block).join(' ')).join(' ');
      case 'code':
        return b.v;
      case 'hr':
        return '';
    }
  };
  return parseChatMarkdown(src).map(block).join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- mentions

/** How a mention reads as plain text: `@everyone`, `@here`, or `@` and the name when it is known (else a generic word). */
export function mentionLabel(
  n: { kind: MentionKind; id: string | null },
  nameOf?: (kind: MentionKind, id: string | null) => string | undefined,
): string {
  if (n.kind === 'everyone' || n.kind === 'here') return `@${n.kind}`;
  return `@${nameOf?.(n.kind, n.id) ?? n.kind}`;
}

/**
 * The mention tokens of a message, as the reader sees them: tokens inside code or escaped with a backslash are not mentions,
 * and each person or role counts once (at most MENTION_LIMITS of each). These are claims only: the server decides which hold.
 */
export function extractMentions(src: string): MentionsDto {
  const found: MentionsDto = { users: [], roles: [], everyone: false, here: false };
  const inline = (nodes: readonly Inline[]): void => {
    for (const n of nodes) {
      if (n.t === 'mention') {
        if (n.kind === 'everyone') found.everyone = true;
        else if (n.kind === 'here') found.here = true;
        else {
          const list = n.kind === 'user' ? found.users : found.roles;
          const max = n.kind === 'user' ? MENTION_LIMITS.users : MENTION_LIMITS.roles;
          if (!list.includes(n.id!) && list.length < max) list.push(n.id!);
        }
      } else if ('c' in n) inline(n.c);
    }
  };
  const block = (b: Block): void => {
    if (b.t === 'p' || b.t === 'h') inline(b.c);
    else if (b.t === 'quote') b.c.forEach(block);
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach((item) => item.forEach(block));
  };
  parseChatMarkdown(src).forEach(block);
  return found;
}
