import type { JSONContent } from '@tiptap/core';

const INLINE_LEAVES = new Set(['text', 'inlineMath', 'hardBreak']);

/**
 * Flattens a document to plain text for full-text search. Includes the searchable parts of
 * non-text blocks (math, diagrams, chart labels, plot expressions, captions).
 */
export function extractText(doc: JSONContent, maxLength = 500_000): string {
  const out: string[] = [];
  let length = 0;

  const push = (s: string) => {
    if (!s || length >= maxLength) return;
    out.push(s);
    length += s.length;
  };

  const visit = (node: JSONContent): void => {
    if (length >= maxLength) return;
    const a = (node.attrs ?? {}) as Record<string, any>;
    switch (node.type) {
      case 'text':
        push(node.text ?? '');
        return;
      case 'hardBreak':
        push('\n');
        return;
      case 'inlineMath':
      case 'blockMath':
        push(String(a['latex'] ?? ''));
        break;
      case 'mermaid':
        push(String(a['code'] ?? ''));
        break;
      case 'imageFigure':
        push(`${a['alt'] ?? ''} ${a['caption'] ?? ''}`);
        break;
      case 'video':
        push(String(a['caption'] ?? ''));
        break;
      case 'chart':
        push(
          [
            a['options']?.title,
            ...(a['data']?.labels ?? []),
            ...(a['data']?.datasets ?? []).map((d: { label?: string }) => d.label),
          ]
            .filter(Boolean)
            .join(' '),
        );
        break;
      case 'functionPlot':
        push(
          [
            a['title'],
            ...(a['expressions'] ?? []).map((e: Record<string, string>) => e['fn'] ?? e['r'] ?? `${e['x']} ${e['y']}`),
          ]
            .filter(Boolean)
            .join(' '),
        );
        break;
    }
    for (const child of node.content ?? []) visit(child);
    if (!INLINE_LEAVES.has(node.type ?? '')) push('\n');
  };

  visit(doc);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

/** Every media id (images, videos and video posters) a document references, without duplicates. */
export function collectMediaIds(doc: JSONContent): string[] {
  const ids = new Set<string>();
  const visit = (node: JSONContent): void => {
    if (node.type === 'imageFigure' || node.type === 'video') {
      const a = (node.attrs ?? {}) as Record<string, unknown>;
      for (const key of ['mediaId', 'posterId']) {
        if (typeof a[key] === 'string') ids.add(a[key] as string);
      }
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return [...ids];
}

/** Number of words, counting runs of letters/digits (works for accented text). */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}
