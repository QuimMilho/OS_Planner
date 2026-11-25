import type { JSONContent } from '@tiptap/core';

/** What a page holds before anything is typed. Kept in its own file so the light entry point can ship it alone. */
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
