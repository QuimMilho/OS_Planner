import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import type { PageDto } from '@os-planner/shared';
import { uuidv7 } from '../core/ids';
import { Db, type PageContentRow } from './db';

const LOCAL_SNAPSHOTS_KEPT = 20;

/** Reading and writing a page's document locally, and fetching it from the server when needed. */
@Injectable({ providedIn: 'root' })
export class PageStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);

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

  /**
   * Keeps this device's copy of the page text in step with what is on screen, for the things that read pages without opening
   * them (search, export, the preview). It queues nothing: the server has the page through the co-editing connection.
   */
  async cacheContent(id: string, doc: JSONContent): Promise<void> {
    const db = this.dbs.db;
    await db.transaction('rw', db.contents, db.pages, async () => {
      const row = await db.contents.get(id);
      const meta = await db.pages.get(id);
      await db.contents.put({ id, content: doc, baseVersion: meta?.version ?? row?.baseVersion ?? 0, dirty: 0, rev: (row?.rev ?? 0) + 1 });
    });
  }

  /** Remembers the page as this device has it, just before its offline changes are merged with the server's (an entry of the Local history). */
  async saveLocalSnapshot(pageId: string, state: Uint8Array): Promise<void> {
    const db = this.dbs.db;
    const meta = await db.pages.get(pageId);
    const at = Date.now();
    const days = ((await db.meta.get('historyDays'))?.value as number | undefined) ?? 30;
    await db.localHistory.add({
      id: uuidv7(),
      at,
      createdAt: at,
      device: (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? '',
      entity: 'page',
      entityId: pageId,
      entityTitle: meta?.title ?? '',
      spaceId: meta?.spaceId ?? '',
      op: 'page.merge',
      fieldsRejected: {},
      patch: {},
      snapshot: meta ?? null,
      reason: 'pre_merge',
      resolved: 'none',
      expiresAt: at + days * 86_400_000,
      bytes: state.byteLength + 400,
      pageId,
      state,
    });
    const all = await db.localHistory.where('pageId').equals(pageId).sortBy('createdAt');
    if (all.length > LOCAL_SNAPSHOTS_KEPT) await db.localHistory.bulkDelete(all.slice(0, all.length - LOCAL_SNAPSHOTS_KEPT).map((r) => r.id));
  }
}
