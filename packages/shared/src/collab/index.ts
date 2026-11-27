// `@os-planner/shared/collab`: the conversion between a stored page document (TipTap JSON) and its Yjs document.
// Kept apart from the main entry on purpose: it pulls in Yjs, which only the editor and the collaboration server use.
import type { JSONContent } from '@tiptap/core';
import {
  prosemirrorJSONToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProsemirrorJSON,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { EMPTY_DOC, isBlankDoc } from '../doc/empty';
import { getDocSchema } from '../doc/validate';
import { COLLAB_FIELD } from '../dto/collab-consts';

export * from '../dto/collab-consts';

/**
 * The client id the first Yjs state of a page is built with. A page that has no Yjs state yet is built from its JSON by
 * the server (and by nobody else): building twice from the same JSON gives byte-identical states, so two servers racing
 * to create it agree. (A client never builds from JSON.)
 */
export const SEED_CLIENT_ID = 1;

/**
 * The canonical form of a document: what ProseMirror makes of it (every attribute present with its default). A Yjs
 * document does not keep attributes that are null or undefined, so JSON read from one is put through the schema, which
 * is also what the editor's `getJSON()` gives.
 */
export function canonicalJSON(json: JSONContent): JSONContent {
  return getDocSchema().nodeFromJSON(json).toJSON() as JSONContent;
}

/**
 * The document held in a Yjs document, as stored JSON (canonical form). A fragment nothing was ever written to is the empty
 * page: ProseMirror gives an empty page one empty paragraph, and the first editor that opens it writes that paragraph.
 */
export function yDocToJSON(doc: Y.Doc): JSONContent {
  const fragment = doc.getXmlFragment(COLLAB_FIELD);
  if (fragment.length === 0) return canonicalJSON(EMPTY_DOC);
  return canonicalJSON(yXmlFragmentToProsemirrorJSON(fragment) as JSONContent);
}

/**
 * A Yjs document for a page that has none yet. Deterministic: the same JSON always gives the same state. A blank page gets a
 * blank fragment, not a paragraph: the paragraph is written by whoever opens the page first, and two people who open a new page
 * would otherwise each end up with the paragraph the server wrote *and* their own.
 */
export function jsonToYDoc(json: JSONContent): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = SEED_CLIENT_ID;
  if (!isBlankDoc(json))
    prosemirrorJSONToYXmlFragment(getDocSchema(), json, doc.getXmlFragment(COLLAB_FIELD));
  return doc;
}

/**
 * Changes the document held in `doc` so that it reads as `json`, as a normal Yjs update (a diff, not a replacement): what
 * other people typed elsewhere in the page survives. Used when an old client saves over HTTP and when a page is restored
 * to an earlier version. Returns whether anything changed.
 */
export function applyJSON(doc: Y.Doc, json: JSONContent): boolean {
  const fragment = doc.getXmlFragment(COLLAB_FIELD);
  const before = Y.encodeStateVector(doc);
  const node = getDocSchema().nodeFromJSON(json);
  doc.transact(() => {
    updateYFragment(doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
  });
  const after = Y.encodeStateVector(doc);
  return before.length !== after.length || before.some((b, i) => b !== after[i]);
}

/** A Yjs state as stored (binary) loaded into a fresh document. */
export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}
