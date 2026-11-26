import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, Subject, debounceTime } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import { collectMediaIds, EMPTY_DOC, positionBetween } from '@os-planner/shared/lite';
import type { SpaceChangesDto, SyncBatchResponse, SyncChangesDto, SyncOp } from '@os-planner/shared';
import { AuthStore, isUnreachable } from '../core/auth-store';
import { Language } from '../core/i18n';
import { uuidv7 } from '../core/ids';
import { Online } from '../core/online';
import { Platform } from '../core/platform';
import { QuotaStore } from '../core/quota';
import { Db, type MediaRow, type PageContentRow } from './db';
import { liveSignal } from './live';
import { Outbox } from './outbox';
import { PageStore } from './page-store';
import { TeamStore } from './team-store';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

/** Something the user should know about: a conflict copy was made, a file was refused, an edit was dropped. */
export interface SyncIssue {
  id: string;
  messageKey: string;
  params?: Record<string, unknown>;
  /** A page the user can open to see the outcome (e.g. the conflict copy). */
  pageId?: string;
  at: number;
}

const POLL_MS = 60_000;
const BATCH = 100;
const PREFETCH_PER_CYCLE = 60;
const PREFETCH_CONCURRENCY = 3;

const isNetworkError = isUnreachable;
const statusOf = (e: unknown): number => (e instanceof HttpErrorResponse ? e.status : -1);
const bodyOf = (e: unknown): Record<string, unknown> => ((e instanceof HttpErrorResponse && e.error) || {}) as Record<string, unknown>;

/** Removes images/videos the server will never have, so the rest of the page can still be saved. */
export function stripMedia(doc: JSONContent, missing: ReadonlySet<string>): JSONContent {
  const walk = (node: JSONContent): JSONContent | null => {
    const a = node.attrs as Record<string, unknown> | undefined;
    if ((node.type === 'imageFigure' || node.type === 'video') && a && missing.has(String(a['mediaId']))) return null;
    const attrs = node.type === 'video' && a && missing.has(String(a['posterId'])) ? { ...a, posterId: null } : node.attrs;
    const content = node.content?.map(walk).filter((n): n is JSONContent => n !== null);
    return { ...node, ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) };
  };
  const out = walk(doc)!;
  return out.content?.length ? out : (structuredClone(EMPTY_DOC) as JSONContent);
}

/**
 * Keeps the local database and the server in step.
 *
 * One cycle: push queued tree operations → upload media → push edited page contents (with a
 * version check) → pull what changed elsewhere → prefetch page contents for offline use.
 * It never loses an edit: when the server refuses a save because the page changed meanwhile,
 * the local text is kept as a separate "conflict copy" page.
 */
@Injectable({ providedIn: 'root' })
export class Sync {
  private readonly http = inject(HttpClient);
  private readonly dbs = inject(Db);
  private readonly auth = inject(AuthStore);
  private readonly outbox = inject(Outbox);
  private readonly pagesStore = inject(PageStore);
  private readonly online = inject(Online);
  private readonly lang = inject(Language);
  private readonly platform = inject(Platform);
  private readonly quota = inject(QuotaStore);
  private readonly teamStore = inject(TeamStore);

  readonly state = signal<SyncState>('idle');
  readonly lastSyncAt = signal<Date | null>(null);
  readonly issues = signal<SyncIssue[]>([]);
  /** Set when uploads are blocked because the email address is not verified yet. */
  readonly needsVerification = signal(false);

  /** Changes waiting to reach the server: queued operations + edited pages + files not yet uploaded. */
  readonly pending = liveSignal(
    this.dbs,
    async (d) =>
      (await d.outbox.count()) +
      (await d.contents.where('dirty').equals(1).filter((c) => c.heldRev !== c.rev).count()) +
      // A file waiting for room is not "in flight": the storage message already says so.
      (await d.media.where('uploaded').equals(0).filter((m) => !m.failed && !m.blocked).count()),
    0,
  );

  private running: Promise<void> | null = null;
  private rerun = false;
  private readonly kick$ = new Subject<void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private channel: BroadcastChannel | null = null;
  private started = false;
  private readonly toFetch = new Set<string>();
  private refusedThisCycle = false;
  private quotaNotified = false;

  /** Starts background syncing for the open database. Safe to call repeatedly. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.kick$.pipe(debounceTime(1500)).subscribe(() => void this.run());
    this.outbox.changed.subscribe(() => {
      this.kick$.next();
      this.channel?.postMessage('changed'); // tell other tabs of this account
    });
    addEventListener('online', () => void this.run());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void this.run());
    this.timer = setInterval(() => void this.run(), POLL_MS);
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('os_planner-sync');
      this.channel.onmessage = () => this.kick$.next();
    }
    void this.run();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.channel?.close();
    this.channel = null;
  }

  dismissIssue(id: string): void {
    this.issues.update((list) => list.filter((i) => i.id !== id));
  }

  /** Runs a cycle now (or as soon as the current one ends). */
  run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.guarded().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        void this.run();
      }
    });
    return this.running;
  }

  private async guarded(): Promise<void> {
    const userId = this.auth.userId();
    if (!userId || !this.dbs.current()) return;
    if (!this.online.isOnline()) return void this.state.set('offline');

    const body = async () => {
      this.state.set('syncing');
      try {
        if (!this.auth.getToken() && !(await this.auth.refresh())) return;
        if (!this.auth.getToken()) return void this.state.set('offline'); // still an offline session
        await this.cycle();
        this.lastSyncAt.set(new Date());
        this.state.set('idle');
        void this.quota.refresh();
      } catch (e) {
        if (isNetworkError(e)) this.state.set('offline');
        else {
          console.error('sync failed', e);
          this.state.set('error');
        }
      }
    };
    // One tab syncs at a time; the others are told to wake up through the BroadcastChannel.
    if (navigator.locks) await navigator.locks.request(`os_planner-sync-${userId}`, { ifAvailable: true }, async (lock) => lock && body());
    else await body();
  }

  private async cycle(): Promise<void> {
    this.refusedThisCycle = false;
    await this.pushOperations();
    await this.uploadMedia();
    await this.pushContents();
    await this.teamStore.refreshAll(); // teams, projects, members: also tells which spaces to ask for
    await this.pull();
    await this.prefetch();
    if (!this.refusedThisCycle) {
      // Everything that was held back for lack of room has gone through.
      this.quotaNotified = false;
      this.quota.refused.set(false);
    }
  }

  // ------------------------------------------------------------------ push: tree operations

  private async pushOperations(): Promise<void> {
    const db = this.dbs.db;
    for (;;) {
      const rows = await db.outbox.orderBy('n').limit(BATCH).toArray();
      if (!rows.length) return;
      const res = await firstValueFrom(this.http.post<SyncBatchResponse>('/api/sync/batch', { ops: rows.map((r) => r.op) }));

      const byOp = new Map(res.results.map((r) => [r.opId, r]));
      const done: number[] = [];
      let blocked = false;
      for (const row of rows) {
        const result = byOp.get(row.op.opId);
        if (!result || (!result.ok && (result.error === 'internal' || result.error === 'quota_exceeded'))) {
          if (result && !result.ok && result.error === 'quota_exceeded') this.quotaRefused();
          blocked = true; // retry later (for a full quota: once space is freed); keep order
          break;
        }
        done.push(row.n!);
        if (!result.ok) this.dropped(row.op, result.error);
      }
      await db.outbox.bulkDelete(done);
      if (blocked || rows.length < BATCH) return;
    }
  }

  /** Tells the person once (not every minute) that storage is full and that nothing is lost. */
  private quotaRefused(): void {
    this.refusedThisCycle = true;
    if (!this.quotaNotified) this.addIssue({ messageKey: 'sync.quotaExceeded' });
    this.quotaNotified = true;
    this.quota.markRefused();
  }

  private dropped(op: SyncOp, reason: string): void {
    // not_found for a delete/restore is normal after another device purged the item; everything else the user should hear about.
    this.addIssue({ messageKey: 'sync.opDropped', params: { type: op.type, reason } });
  }

  // ------------------------------------------------------------------ push: media

  private async uploadMedia(): Promise<void> {
    const db = this.dbs.db;
    const pending = await db.media.where('uploaded').equals(0).filter((m) => !m.failed).toArray(); // blocked ones too: they are retried
    for (const row of pending) {
      if (!(await this.uploadOne(row))) break; // unverified email or server trouble: try again next cycle
    }
  }

  /** Returns false when uploads should pause (not an error for this file). */
  private async uploadOne(row: MediaRow): Promise<boolean> {
    const form = new FormData();
    form.append('id', row.id);
    if (row.width) form.append('width', String(row.width));
    if (row.height) form.append('height', String(row.height));
    if (row.durationSec != null) form.append('durationSec', String(row.durationSec));
    form.append('file', row.blob, row.id);
    try {
      await firstValueFrom(this.http.post('/api/media', form));
      await this.dbs.db.media.update(row.id, { uploaded: 1, blocked: null });
      this.needsVerification.set(false);
      return true;
    } catch (e) {
      if (isNetworkError(e)) throw e;
      const status = statusOf(e);
      const message = String(bodyOf(e)['message'] ?? '');
      if (status === 403 && message === 'email_not_verified') {
        this.needsVerification.set(true);
        return false;
      }
      if (status === 409) return (await this.dbs.db.media.update(row.id, { uploaded: 1 }), true); // already there
      if (status >= 500 || status === 401 || status === 429) return false;
      if (status === 413 && message === 'quota_exceeded') {
        // Not the file's fault: it stays on this device, queued, and goes up once there is room.
        await this.dbs.db.media.update(row.id, { blocked: 'quota' });
        this.quotaRefused();
        return true; // a smaller file queued behind it may still fit
      }
      // 413 (too large) / 415 / 422: the server will never accept this file
      await this.dbs.db.media.update(row.id, { failed: message || `http_${status}` });
      this.addIssue({ messageKey: 'sync.uploadRefused', params: { reason: message } });
      return true;
    }
  }

  // ------------------------------------------------------------------ push: page contents

  private async pushContents(): Promise<void> {
    const db = this.dbs.db;
    const dirty = await db.contents.where('dirty').equals(1).toArray();
    for (const row of dirty) {
      const meta = await db.pages.get(row.id);
      // A page created offline must exist on the server before its content can be saved.
      if (!meta || (await db.outbox.filter((o) => 'id' in o.op && o.op.id === row.id).count())) continue;
      await this.pushContent(row);
    }
  }

  private async pushContent(row: PageContentRow, retried = false): Promise<void> {
    const db = this.dbs.db;
    // Files used by this page must be on the server first, or it would reject the reference.
    const mediaIds = collectMediaIds(row.content);
    let content = row.content;
    let held = false;
    if (mediaIds.length) {
      const media = await db.media.bulkGet(mediaIds);
      const waiting = mediaIds.filter((_id, i) => media[i] && !media[i]!.uploaded && !media[i]!.failed);
      const blocked = waiting.filter((id) => media[mediaIds.indexOf(id)]!.blocked === 'quota');
      if (waiting.length > blocked.length) return; // wait for the upload
      const refused = mediaIds.filter((id, i) => media[i]?.failed);
      if (refused.length) return this.rewrite(row, stripMedia(row.content, new Set(refused)));
      if (blocked.length) {
        // Storage is full: the files wait here, but the text must still reach the server.
        if (row.heldRev === row.rev) return; // it already has this text
        content = stripMedia(row.content, new Set(blocked));
        held = true;
      }
    }

    try {
      const res = await firstValueFrom(this.http.put<{ version: number }>(`/api/pages/${row.id}/content`, { content, baseVersion: row.baseVersion }));
      await db.transaction('rw', db.contents, async () => {
        const now = await db.contents.get(row.id);
        if (!now) return;
        // If the user typed while this was in flight, keep it dirty so the newer text is sent next.
        const same = now.rev === row.rev;
        await db.contents.put({ ...now, baseVersion: res.version, dirty: same && !held ? 0 : 1, heldRev: same && held ? row.rev : undefined });
      });
    } catch (e) {
      if (isNetworkError(e)) throw e;
      const status = statusOf(e);
      const body = bodyOf(e);
      if (status === 409) return this.resolveConflict(row, body['version'] as number, body['content'] as JSONContent);
      if (status === 404) return this.restoreAsCopy(row);
      if (status === 422 && body['message'] === 'unknown_media' && !retried) {
        // The server does not have a file this page refers to (e.g. it was cleaned up). Re-upload what we hold, drop the rest.
        const missing = new Set<string>(body['missing'] as string[]);
        const held = (await db.media.bulkGet([...missing])).filter((m): m is MediaRow => !!m);
        await Promise.all(held.map((m) => db.media.update(m.id, { uploaded: 0 })));
        for (const m of held) await this.uploadOne({ ...m, uploaded: 0 });
        const gone = new Set([...missing].filter((id) => !held.some((h) => h.id === id)));
        if (gone.size) return this.rewrite(row, stripMedia(row.content, gone));
        return this.pushContent((await db.contents.get(row.id)) ?? row, true);
      }
      if (status === 422) {
        this.addIssue({ messageKey: 'sync.invalidDocument', pageId: row.id });
        return;
      }
      if (status === 413 && body['message'] === 'quota_exceeded') {
        this.quotaRefused(); // the text stays dirty on this device and is sent once there is room
        return;
      }
      if (status === 401 || status >= 500 || status === 429) throw e;
      console.error('content push refused', status, body);
    }
  }

  /** Replaces a page's local content (marking it as edited) and tries again on the next cycle. */
  private async rewrite(row: PageContentRow, content: JSONContent): Promise<void> {
    await this.dbs.db.contents.put({ ...row, content, dirty: 1, rev: row.rev + 1 });
    this.addIssue({ messageKey: 'sync.mediaRemoved', pageId: row.id });
  }

  /**
   * The page changed on the server since this device last saw it. Nothing is overwritten: the
   * server's version becomes the page, and what was typed here is kept as a new page next to it.
   */
  private async resolveConflict(local: PageContentRow, serverVersion: number, serverContent: JSONContent): Promise<void> {
    const db = this.dbs.db;
    const copyId = await this.makeCopy(local.id, local.content, 'sync.conflictCopy');
    await db.contents.put({ id: local.id, content: serverContent, baseVersion: serverVersion, dirty: 0, rev: local.rev + 1 });
    this.addIssue({ messageKey: 'sync.conflict', pageId: copyId ?? local.id });
  }

  /** The page no longer exists on the server (purged or deleted elsewhere): keep the text as a new page. */
  private async restoreAsCopy(local: PageContentRow): Promise<void> {
    const db = this.dbs.db;
    const copyId = await this.makeCopy(local.id, local.content, 'sync.restoredCopy');
    await db.contents.put({ ...local, dirty: 0 });
    await db.pages.where('id').equals(local.id).modify({ deletedAt: new Date().toISOString() });
    this.addIssue({ messageKey: 'sync.pageGone', pageId: copyId ?? undefined });
  }

  private async makeCopy(originalId: string, content: JSONContent, labelKey: string): Promise<string | null> {
    const db = this.dbs.db;
    const original = await db.pages.get(originalId);
    if (!original) return null;
    const id = uuidv7();
    const stamp = new Date().toISOString();
    const device = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? this.platform.os;
    const title = `${original.title || this.lang.t('page.untitled')} (${this.lang.t(labelKey)} – ${device} – ${this.lang.date(stamp)})`;
    const siblings = await db.pages.where('categoryId').equals(original.categoryId).filter((p) => !p.deletedAt).toArray();
    const last = siblings.map((p) => p.position).sort().at(-1) ?? null;
    const position = positionBetween(last, null);
    await db.transaction('rw', db.pages, db.contents, async () => {
      await db.pages.add({ ...original, id, title, position, version: 0, seq: 0, deletedAt: null, createdAt: stamp, updatedAt: stamp });
      await db.contents.add({ id, content, baseVersion: 0, dirty: 1, rev: 1 });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'page.create', id, categoryId: original.categoryId, title, position });
    return id;
  }

  // ------------------------------------------------------------------ pull

  /**
   * Asks for what changed in every space this device holds: the personal one, and the space of
   * each team and project the person can see. One cursor per space, kept in `meta.cursors`.
   * Spaces the server says were revoked (left the team, project deleted, ...) are purged here.
   */
  private async pull(): Promise<void> {
    const db = this.dbs.db;
    const personal = this.auth.user()?.personalSpaceId;
    if (!personal) return this.pullLegacy(); // an offline session restored from before spaces existed: one cursor, personal data

    const stored = ((await db.meta.get('cursors'))?.value as Record<string, number> | undefined) ?? {};
    const cursors: Record<string, number> = { ...stored };
    if (cursors[personal] === undefined) cursors[personal] = ((await db.meta.get('cursor'))?.value as number | undefined) ?? 0; // the single cursor of older versions
    // Read the tables themselves: the live signals may not have caught up with what refreshAll just wrote.
    const spaces = [personal, ...(await db.teams.toArray()).map((t) => t.spaceId), ...(await db.projects.toArray()).map((p) => p.spaceId)];
    for (const id of spaces) cursors[id] ??= 0;

    for (;;) {
      const res = await firstValueFrom(this.http.get<SyncChangesDto>('/api/sync/changes', { params: { cursors: JSON.stringify(cursors) } }));
      let more = false;
      for (const [spaceId, changes] of Object.entries(res.spaces)) {
        await this.apply(changes);
        cursors[spaceId] = changes.cursor;
        more ||= changes.hasMore;
      }
      if (res.revokedSpaces.length) {
        await this.teamStore.purgeSpaces(res.revokedSpaces);
        for (const id of res.revokedSpaces) delete cursors[id];
      }
      // purgeSpaces rewrites the stored cursors; keep the ones we hold now
      await db.meta.put({ key: 'cursors', value: cursors });
      if (!more) return;
    }
  }

  private async pullLegacy(): Promise<void> {
    const db = this.dbs.db;
    let cursor = ((await db.meta.get('cursor'))?.value as number | undefined) ?? 0;
    for (;;) {
      const changes = await firstValueFrom(this.http.get<SyncChangesDto>('/api/sync/changes', { params: { since: cursor } }));
      await this.apply(changes);
      cursor = changes.cursor;
      await db.meta.put({ key: 'cursor', value: cursor });
      if (!changes.hasMore) return;
    }
  }

  /** Writes server changes locally, except for things with queued local changes (those are sent first and win). */
  private async apply(changes: SpaceChangesDto): Promise<void> {
    const db = this.dbs.db;
    await db.transaction('rw', db.notebooks, db.categories, db.pages, db.contents, db.outbox, async () => {
      const protectedIds = new Set((await db.outbox.toArray()).map((o) => ('id' in o.op ? o.op.id : '')));
      const keep = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !protectedIds.has(r.id));
      await db.notebooks.bulkPut(keep(changes.notebooks));
      await db.categories.bulkPut(keep(changes.categories));
      const pages = keep(changes.pages);
      await db.pages.bulkPut(pages);

      for (const p of pages) {
        if (p.deletedAt) continue;
        const content = await db.contents.get(p.id);
        if (!content || (!content.dirty && content.baseVersion < p.version)) this.toFetch.add(p.id);
      }
    });
  }

  /** Brings page documents down in the background so the notes are available offline. */
  private async prefetch(): Promise<void> {
    const ids = [...this.toFetch].slice(0, PREFETCH_PER_CYCLE);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        if (await this.pagesStore.fetchContent(id)) this.toFetch.delete(id);
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    if (this.toFetch.size) this.kick$.next(); // more to do: continue shortly
  }

  private addIssue(issue: Omit<SyncIssue, 'id' | 'at'>): void {
    this.issues.update((list) => [...list.slice(-9), { ...issue, id: uuidv7(), at: Date.now() }]);
  }
}
