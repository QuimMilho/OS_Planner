import type { JSONContent } from '@tiptap/core';

/**
 * Version of the stored document schema. Bump it when a change to the schema needs existing
 * documents rewritten, and register a migration for the previous version below.
 */
export const CURRENT_SCHEMA_VERSION = 1;

type Migration = (doc: JSONContent) => JSONContent;

/** migrations[n] upgrades a version-n document to version n + 1. */
const migrations: Record<number, Migration> = {};

export function migrateDoc(doc: JSONContent, fromVersion: number): JSONContent {
  let current = doc;
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (!step) throw new Error(`No migration from schema version ${v}`);
    current = step(current);
  }
  return current;
}
