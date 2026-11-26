/** The cursor key of a notebook shared with the person (the cursors of ordinary spaces are space ids). Free of zod: the app loads it early. */
export const sharedCursorKey = (notebookId: string): string => `shared:${notebookId}`;
export const isSharedCursorKey = (key: string): boolean => key.startsWith('shared:');
export const notebookOfSharedKey = (key: string): string => key.slice('shared:'.length);
