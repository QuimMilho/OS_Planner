import { Injectable } from '@nestjs/common';
import type { Hocuspocus } from '@hocuspocus/server';
import type * as Y from 'yjs';

/** What the server remembers about one co-editing connection (set when it authenticates). */
export interface CollabContext {
  userId: string;
  sessionId: string;
  /** Shown on the person's caret. Taken from the account, never from the client. */
  name: string;
  pageId: string;
  spaceId: string;
  notebookId: string;
  canEdit: boolean;
  connectedAt: number;
  /** Token bucket for the rate limit. */
  tokens: number;
  tokensAt: number;
}

/**
 * The bridge between the rest of the API and the co-editing server: whether a page has people in it right now, and a way
 * to change an open document the way a client would (so everybody in it sees the change). Filled in by CollabServer.
 */
@Injectable()
export class CollabRegistry {
  hocuspocus: Hocuspocus | null = null;

  /** The page's document is loaded on this instance: somebody is editing it (or just was and it is being stored). */
  isOpen(pageId: string): boolean {
    return (
      this.hocuspocus?.documents.has(pageId) === true ||
      this.hocuspocus?.loadingDocuments.has(pageId) === true
    );
  }

  /** The connections of a page on this instance. */
  contexts(pageId: string): CollabContext[] {
    const doc = this.hocuspocus?.documents.get(pageId);
    if (!doc) return [];
    return [...doc.connections.keys()].map((c) => c.context as CollabContext);
  }

  /** Writes what people typed in the page and is waiting for its debounce now (so the stored version is the live one). */
  async flush(pageId: string): Promise<void> {
    const hp = this.hocuspocus;
    const doc = hp?.documents.get(pageId);
    if (!hp || !doc) return;
    const id = `onStoreDocument-${pageId}`;
    if (hp.debouncer.isDebounced(id)) await hp.debouncer.executeNow(id);
    else if (hp.debouncer.isCurrentlyExecuting(id)) await doc.saveMutex.waitForUnlock();
  }

  /** Runs `fn` against the page's live document, as one change that is broadcast and then stored. */
  async change<T>(pageId: string, fn: (doc: Y.Doc) => T, by: { userId?: string } = {}): Promise<T> {
    const hp = this.hocuspocus;
    if (!hp) throw new Error('collaboration server not started');
    const direct = await hp.openDirectConnection(pageId, { internal: true, ...by });
    try {
      let result!: T;
      await direct.transact((doc) => {
        result = fn(doc);
      });
      return result;
    } finally {
      await direct.disconnect();
    }
  }
}
