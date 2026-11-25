import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import {
  chartDataSchema,
  chartOptionsSchema,
  CHART_TYPES,
  getSchemaExtensions,
  plotSpecSchema,
  type CalloutVariant,
  type MediaPathResolver,
} from '../schema';
import { EMPTY_DOC } from './empty';
import { validateDoc, type ValidateResult } from './validate';

export interface MarkdownExportOptions {
  /** Maps a media id to the relative path used in the exported file. */
  mediaPath?: MediaPathResolver;
}

/** Serialises a stored document to Markdown. Custom blocks become fenced code / GitHub alerts. */
export function docToMarkdown(doc: JSONContent, options: MarkdownExportOptions = {}): string {
  const manager = new MarkdownManager({
    extensions: getSchemaExtensions({ mediaPath: options.mediaPath }),
  });
  return manager.serialize(doc).trim() + '\n';
}

const ALERTS: Record<string, CalloutVariant> = {
  NOTE: 'info',
  TIP: 'tip',
  IMPORTANT: 'info',
  WARNING: 'warning',
  CAUTION: 'danger',
};

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(plainText).join('');
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Turns a fenced code block with a known language into the matching rich block, if valid. */
function richBlockFromCode(node: JSONContent): JSONContent | null {
  const lang = String(node.attrs?.['language'] ?? '').toLowerCase();
  const code = plainText(node);
  if (lang === 'mermaid') return { type: 'mermaid', attrs: { code } };

  if (lang === 'chart') {
    const spec = tryJson(code) as { type?: string; data?: unknown; options?: unknown } | undefined;
    const data = chartDataSchema.safeParse(spec?.data);
    const options = chartOptionsSchema.safeParse(spec?.options ?? {});
    if (spec && (CHART_TYPES as readonly string[]).includes(spec.type ?? '') && data.success && options.success) {
      return { type: 'chart', attrs: { type: spec.type, data: data.data, options: options.data } };
    }
  }

  if (lang === 'plot') {
    const spec = plotSpecSchema.safeParse(tryJson(code));
    if (spec.success) {
      return { type: 'functionPlot', attrs: { ...spec.data, yDomain: spec.data.yDomain ?? null, title: spec.data.title ?? '' } };
    }
  }
  return null;
}

/** `> [!NOTE]` style blockquote -> callout. Returns null when the blockquote is a normal quote. */
function calloutFromQuote(node: JSONContent): JSONContent | null {
  const first = node.content?.[0];
  if (first?.type !== 'paragraph') return null;
  const head = first.content?.[0];
  if (head?.type !== 'text') return null;
  // The marker is the first line of the first text node: "[!NOTE]" or "[!NOTE]\nbody...".
  const match = /^\[!([A-Za-z]+)\][ \t]*(?:\r?\n|$)/.exec(head.text ?? '');
  const variant = match ? ALERTS[match[1]!.toUpperCase()] : undefined;
  if (!match || !variant) return null;

  const rest = (first.content ?? []).slice(1);
  const remainder = (head.text ?? '').slice(match[0].length);
  if (remainder) rest.unshift({ ...head, text: remainder });
  // A hard break right after the marker would otherwise leave an empty first line.
  if (rest[0]?.type === 'hardBreak') rest.shift();
  const body: JSONContent[] = [];
  if (rest.length) body.push({ type: 'paragraph', content: rest });
  body.push(...(node.content ?? []).slice(1));
  return { type: 'callout', attrs: { variant }, content: body.length ? body : [{ type: 'paragraph' }] };
}

const BLOCK_LEAVES = new Set(['imageFigure', 'video']);

/** Block nodes cannot live inside a paragraph: split the paragraph around them. */
function liftBlocks(paragraph: JSONContent): JSONContent[] {
  const children = paragraph.content ?? [];
  if (!children.some((c) => BLOCK_LEAVES.has(c.type ?? ''))) return [paragraph];
  const out: JSONContent[] = [];
  let run: JSONContent[] = [];
  const flush = () => {
    if (run.length) out.push({ ...paragraph, content: run });
    run = [];
  };
  for (const child of children) {
    if (BLOCK_LEAVES.has(child.type ?? '')) {
      flush();
      out.push(child);
    } else run.push(child);
  }
  flush();
  return out;
}

function normalise(node: JSONContent): JSONContent[] {
  if (node.type === 'codeBlock') {
    const rich = richBlockFromCode(node);
    if (rich) return [rich];
  }
  if (node.type === 'blockquote') {
    const callout = calloutFromQuote(node);
    if (callout) return [{ ...callout, content: (callout.content ?? []).flatMap(normalise) }];
  }
  const content = node.content?.flatMap(normalise);
  const next = content ? { ...node, content } : node;
  return next.type === 'paragraph' ? liftBlocks(next) : [next];
}

/**
 * Parses Markdown into a validated document. Anything the schema cannot represent
 * (raw HTML, remote images, unknown fences) degrades to text rather than failing the import.
 */
export function markdownToDoc(markdown: string): ValidateResult {
  const manager = new MarkdownManager({ extensions: getSchemaExtensions() });
  let parsed: JSONContent;
  try {
    parsed = manager.parse(markdown);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not parse markdown' };
  }
  const content = (parsed.content ?? []).flatMap(normalise);
  return validateDoc({ type: 'doc', content: content.length ? content : EMPTY_DOC.content });
}
