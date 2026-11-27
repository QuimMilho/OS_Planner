import type { JSONContent } from '@tiptap/core';

/** What a page holds before anything is typed. Kept in its own file so the light entry point can ship it alone. */
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** A document with no text and nothing else in it: a new page, or one that was emptied. */
export function isBlankDoc(json: JSONContent | null | undefined): boolean {
  const content = json?.content;
  if (!content?.length) return true;
  const only = content.length === 1 ? content[0] : undefined;
  return only?.type === 'paragraph' && !only.content?.length;
}
