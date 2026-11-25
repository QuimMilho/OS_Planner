import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import type { PageDto } from '@notes/shared';
import { Db, type PageContentRow } from './db';
import { Outbox } from './outbox';

/** Reading and writing a page's document locally, and fetching it from the server when needed. */
@Injectable({ providedIn: 'root' })
export class PageStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);
  private readonly outbox = inject(Outbox);

  /** The local copy, fetching it from the server first if this device has never seen it. */
  async load(id: string): Promise<PageContentRow | null> {
    const local = await this.dbs.db.contents.get(id);
    if (local) return local;
    return (await this.fetchContent(id)) ? ((await this.dbs.db.contents.get(id)) ?? null) : null;
  }

  /**
   * Downloads the document and stores it, unless the user has unsent local edits (those win
   * and are reconciled when they are pushed). Resolves false if offline or not found.
   */
  async fetchContent(id: string): Promise<boolean> {
    try {
      const page = await firstValueFrom(this.http.get<PageDto>(`/api/pages/${id}`));
      const db = this.dbs.db;
      await db.transaction('rw', db.contents, async () => {
        const existing = await db.contents.get(id);
        if (existing?.dirty) return;
        await db.contents.put({ id, content: page.content, baseVersion: page.version, dirty: 0, rev: existing?.rev ?? 0 });
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Stores an edit locally at once; Sync pushes it with a version check when it can. */
  async saveContent(id: string, doc: JSONContent): Promise<void> {
    const db = this.dbs.db;
    await db.transaction('rw', db.contents, async () => {
      const row = await db.contents.get(id);
      if (!row) return;
      await db.contents.put({ ...row, content: doc, dirty: 1, rev: row.rev + 1 });
    });
    this.outbox.changed.next();
  }
}
