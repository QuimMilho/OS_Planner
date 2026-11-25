import { Injectable, signal } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { JSONContent } from '@tiptap/core';
import type { CategoryDto, NotebookDto, PageMetaDto, SyncOp } from '@notes/shared';

/** The document of a page, kept apart from its metadata so autosave never re-renders the sidebar. */
export interface PageContentRow {
  id: string;
  content: JSONContent;
  /** The server version this content was based on; sent as `baseVersion` when saving. */
  baseVersion: number;
  /** 1 while there are local edits the server has not accepted yet. */
  dirty: 0 | 1;
  /** Bumped on every local edit, so a save that finishes after a newer edit does not clear `dirty`. */
  rev: number;
}

export interface MediaRow {
  id: string;
  kind: 'image' | 'video';
  mime: string;
  size: number;
  blob: Blob;
  /** 0 until the server has the file; uploads happen before any page content that uses it is pushed. */
  uploaded: 0 | 1;
  /** Set when the server permanently refused the file (too large, unsupported, ...). Not retried. */
  failed?: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface OutboxRow {
  n?: number;
  op: SyncOp;
}

export class NotesDb extends Dexie {
  notebooks!: Table<NotebookDto, string>;
  categories!: Table<CategoryDto, string>;
  pages!: Table<PageMetaDto, string>;
  contents!: Table<PageContentRow, string>;
  outbox!: Table<OutboxRow, number>;
  media!: Table<MediaRow, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      notebooks: 'id',
      categories: 'id, notebookId, parentId',
      pages: 'id, notebookId, categoryId',
      contents: 'id, dirty',
      outbox: '++n',
      media: 'id, uploaded',
      meta: 'key',
    });
  }
}

/**
 * One local database per signed-in user, so two accounts on the same device never see each
 * other's notes. Everything in the UI reads from here; the network only feeds it (see Sync).
 */
@Injectable({ providedIn: 'root' })
export class Db {
  /** Null until a user is signed in. */
  readonly current = signal<NotesDb | null>(null);

  open(userId: string): NotesDb {
    const existing = this.current();
    if (existing?.name === `notes-${userId}`) return existing;
    existing?.close();
    const db = new NotesDb(`notes-${userId}`);
    this.current.set(db);
    return db;
  }

  get db(): NotesDb {
    const db = this.current();
    if (!db) throw new Error('No user database is open');
    return db;
  }

  /** Releases the database but keeps its data (a session that merely expired must not destroy unsynced work). */
  close(): void {
    const db = this.current();
    if (!db) return;
    this.current.set(null);
    db.close();
  }

  /** Closes and deletes the local copy (on an explicit sign-out, so notes do not linger on a shared computer). */
  async wipe(): Promise<void> {
    const db = this.current();
    if (!db) return;
    this.current.set(null);
    db.close();
    await Dexie.delete(db.name);
  }
}
