import { BOARD_LIMITS, type TaskDocDto } from '../dto/boards';

/**
 * The reduced document a task description may hold (a small subset of the page schema): paragraphs, line breaks, bullet and
 * numbered lists (nested to a few levels) and text with bold, italic, strike, code and link marks. Nothing else gets in:
 * no images or videos (those are attachments), no embedded content, no scripts in links.
 *
 * Validation is structural and strict (unknown node, mark or attribute = invalid) so a hostile client cannot store anything
 * the editor would not produce. The same function runs on the server and, before sending, in the web app.
 */

const MAX_DEPTH = 6;
const MAX_NODES = 2000;
const MAX_TEXT = 20_000;
const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'];

export const TASK_DOC_NODES = ['doc', 'paragraph', 'bulletList', 'orderedList', 'listItem', 'hardBreak', 'text'] as const;
export const TASK_DOC_MARKS = ['bold', 'italic', 'strike', 'code', 'link'] as const;

export type DescriptionCheck = { ok: true; doc: TaskDocDto | null; bytes: number } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only plain web and mail links: never `javascript:` or `data:`. */
export function isSafeLink(href: unknown): href is string {
  if (typeof href !== 'string' || href.length > 2000) return false;
  try {
    return LINK_PROTOCOLS.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** Checks a description. `null`, `undefined` and an empty document all mean "no description". */
export function validateTaskDescription(input: unknown): DescriptionCheck {
  if (input === null || input === undefined) return { ok: true, doc: null, bytes: 0 };
  if (!isObject(input) || input['type'] !== 'doc') return { ok: false, reason: 'not_a_document' };
  let nodes = 0;
  let text = 0;

  const fail = (reason: string): never => {
    throw new Error(reason);
  };

  const checkMarks = (marks: unknown): void => {
    if (marks === undefined) return;
    if (!Array.isArray(marks) || marks.length > TASK_DOC_MARKS.length) return fail('bad_marks');
    const seen = new Set<string>();
    for (const m of marks) {
      if (!isObject(m) || typeof m['type'] !== 'string' || !(TASK_DOC_MARKS as readonly string[]).includes(m['type'])) return fail('unknown_mark');
      if (seen.has(m['type'])) return fail('duplicate_mark');
      seen.add(m['type']);
      for (const k of Object.keys(m)) if (k !== 'type' && k !== 'attrs') return fail('unknown_key');
      const attrs = m['attrs'];
      if (m['type'] === 'link') {
        if (!isObject(attrs) || !isSafeLink(attrs['href'])) return fail('bad_link');
        for (const k of Object.keys(attrs)) if (!['href', 'target', 'rel', 'class'].includes(k)) return fail('unknown_attr');
      } else if (attrs !== undefined && !(isObject(attrs) && Object.keys(attrs).length === 0)) return fail('unknown_attr');
    }
  };

  const walk = (node: unknown, depth: number, parent: string): void => {
    if (++nodes > MAX_NODES) return fail('too_many_nodes');
    if (depth > MAX_DEPTH) return fail('too_deep');
    if (!isObject(node) || typeof node['type'] !== 'string') return fail('bad_node');
    const type = node['type'];
    if (!(TASK_DOC_NODES as readonly string[]).includes(type) || type === 'doc') return fail('unknown_node');
    for (const k of Object.keys(node)) if (!['type', 'content', 'text', 'marks', 'attrs'].includes(k)) return fail('unknown_key');

    const attrs = node['attrs'];
    if (attrs !== undefined) {
      const allowed = type === 'orderedList' ? ['start', 'type'] : [];
      if (!isObject(attrs)) return fail('bad_attrs');
      for (const [k, v] of Object.entries(attrs)) {
        if (!allowed.includes(k)) return fail('unknown_attr');
        if (k === 'start' && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) < 100_000)) return fail('bad_attrs');
        if (k === 'type' && v !== null && typeof v !== 'string') return fail('bad_attrs');
      }
    }

    if (type === 'text') {
      if (typeof node['text'] !== 'string' || node['text'].length === 0) return fail('bad_text');
      text += node['text'].length;
      if (text > MAX_TEXT) return fail('too_long');
      if (node['content'] !== undefined) return fail('text_with_content');
      if (!['paragraph'].includes(parent)) return fail('misplaced_node');
      return checkMarks(node['marks']);
    }
    if (node['text'] !== undefined || node['marks'] !== undefined) return fail('unknown_key');

    const content = node['content'];
    if (type === 'hardBreak') {
      if (content !== undefined || parent !== 'paragraph') return fail('misplaced_node');
      return;
    }
    if (content !== undefined && !Array.isArray(content)) return fail('bad_content');
    const children = (content as unknown[] | undefined) ?? [];
    if (type === 'paragraph') {
      if (!['doc', 'listItem'].includes(parent)) return fail('misplaced_node');
    } else if (type === 'bulletList' || type === 'orderedList') {
      if (!['doc', 'listItem'].includes(parent) || children.length === 0) return fail('misplaced_node');
    } else if (type === 'listItem') {
      if (!['bulletList', 'orderedList'].includes(parent) || children.length === 0) return fail('misplaced_node');
    }
    for (const child of children) {
      if (type === 'listItem' && isObject(child) && children[0] === child && child['type'] !== 'paragraph') return fail('bad_list_item');
      walk(child, depth + 1, type);
    }
  };

  try {
    for (const k of Object.keys(input)) if (k !== 'type' && k !== 'content') return { ok: false, reason: 'unknown_key' };
    const content = input['content'];
    if (content !== undefined && !Array.isArray(content)) return { ok: false, reason: 'bad_content' };
    for (const child of (content as unknown[] | undefined) ?? []) walk(child, 1, 'doc');
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'invalid' };
  }
  const doc = input as unknown as TaskDocDto;
  if (!taskDocText(doc).trim() && !hasStructure(doc)) return { ok: true, doc: null, bytes: 0 };
  const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
  if (bytes > BOARD_LIMITS.descriptionBytes) return { ok: false, reason: 'too_large' };
  return { ok: true, doc, bytes };
}

function hasStructure(doc: TaskDocDto): boolean {
  return (doc.content ?? []).some((n) => isObject(n) && (n['type'] === 'bulletList' || n['type'] === 'orderedList'));
}

/** The plain text of a description (for previews, notifications and search), blocks separated by a space. */
export function taskDocText(doc: TaskDocDto | null | undefined): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!isObject(node)) return;
    if (node['type'] === 'text' && typeof node['text'] === 'string') out.push(node['text']);
    else if (node['type'] === 'hardBreak') out.push(' ');
    const content = node['content'];
    if (Array.isArray(content)) {
      for (const c of content) walk(c);
      if (node['type'] === 'paragraph' || node['type'] === 'listItem') out.push(' ');
    }
  };
  walk(doc);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** A description made of plain paragraphs, one per line of `text` (what an import or a test needs). */
export function taskDocFromText(text: string): TaskDocDto | null {
  const lines = text.split(/\r?\n/);
  if (!text.trim()) return null;
  return {
    type: 'doc',
    content: lines.map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  };
}
