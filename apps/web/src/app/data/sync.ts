import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, Subject, debounceTime } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import { collectMediaIds, EMPTY_DOC, isSharedCursorKey, lastFieldChange, notebookOfSharedKey, positionBetween } from '@os-planner/shared/lite';
import type { MergeEntity, SpaceChangesDto, SyncBatchResponse, SyncChangesDto, SyncEntityDto, SyncOp, SyncOpResult } from '@os-planner/shared';
import { AuthStore, isUnreachable } from '../core/auth-store';
import { Language } from '../core/i18n';
import { uuidv7 } from '../core/ids';
import { Online } from '../core/online';
import { Platform } from '../core/platform';
import { QuotaStore } from '../core/quota';
import { AccessStore } from './access-store';
import { BoardStore } from './board-store';
import { CalendarStore } from './calendar-store';
import { Db, type MediaRow, type PageContentRow } from './db';
import { HistoryStore } from './history-store';
import { liveSignal } from './live';
import { OfflineScope } from './offline-scope';
import { mergeKindOf, Outbox } from './outbox';
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
  /** An address in the app that shows the outcome (the Local history). */
  link?: string;
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
  private readonly access = inject(AccessStore);
  private readonly boards = inject(BoardStore);
  private readonly calendar = inject(CalendarStore);
  private readonly history = inject(HistoryStore);
  private readonly scope = inject(OfflineScope);

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
    void this.history.load().then(() => this.history.purge());
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
    await this.access.refresh(); // what the person may do in each team, project and shared notebook
    await this.boards.refreshPermissions(); // ... and on each board
    await this.calendar.refresh(); // ... and in each calendar, with the person's calendar settings
    await this.pull();
    await this.prefetch();
    await this.history.purge();
    if (!this.refusedThisCycle) {
      // Everything that was held back for lack of room has gone through.
      this.quotaNotified = false;
      this.quota.refused.set(false);
    }
  }

  // ------------------------------------------------------------------ push: tree operations

  private async pushOperations(): Promise<void> {
    const db = this.dbs.db;
    // Changes the server did not take over as they were (kept in the Local history): told once per push, not per change.
    let notApplied = 0;
    try {
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
          if (result.ok) notApplied += await this.afterApplied(row.op, result);
          else notApplied += await this.afterRefused(row.op, result);
        }
        await db.outbox.bulkDelete(done);
        if (blocked || rows.length < BATCH) return;
      }
    } finally {
      if (notApplied) this.addIssue({ messageKey: 'sync.rejected', params: { count: notApplied }, link: '/app/history' });
    }
  }

  private tableOf(entity: MergeEntity) {
    const db = this.dbs.db;
    return { notebook: db.notebooks, category: db.categories, page: db.pages, task: db.tasks, event: db.events }[entity] as unknown as {
      get(id: string): Promise<(Record<string, unknown> & { spaceId?: string }) | undefined>;
      put(row: unknown): Promise<unknown>;
      update(id: string, changes: Record<string, unknown>): Promise<number>;
    };
  }

  /** What an op carried, without what only says where it goes. */
  private patchOf(op: SyncOp): Record<string, unknown> {
    const { opId: _o, type: _t, id: _i, base: _b, scope: _s, occurrence: _c, ...patch } = op as unknown as Record<string, unknown>;
    return patch;
  }

  /** The op went through (all of it, or all but some fields). */
  private async afterApplied(op: SyncOp, result: Extract<SyncOpResult, { ok: true }>): Promise<number> {
    const kind = mergeKindOf(op);
    if (!kind || !('id' in op)) return 0;
    await this.rebase(op.id, result);
    if (result.status !== 'merged' || !result.rejected) return 0;
    // Some fields lost: the entity as it is online (with this device's other fields applied) replaces the local copy, and what lost is kept.
    const local = await this.tableOf(kind.entity).get(op.id);
    await this.history.record({
      entity: kind.entity,
      entityId: op.id,
      spaceId: local?.spaceId ?? result.entity?.row.spaceId ?? '',
      op: op.type,
      reason: 'conflict',
      fieldsRejected: result.rejected,
      patch: this.patchOf(op),
      snapshot: local ?? result.entity?.row ?? null,
    });
    await this.refreshFrom(kind.entity, op.id, result.entity);
    return 1;
  }

  /** Later changes of the same thing that are still queued are based on what this one wrote. */
  private async rebase(id: string, result: Extract<SyncOpResult, { ok: true }>): Promise<void> {
    const written = result.applied ?? [];
    const fieldSeq = (result.entity?.row as { fieldSeq?: Record<string, number> } | undefined)?.fieldSeq;
    if (!written.length || !fieldSeq) return;
    await this.dbs.db.outbox
      .filter((o) => 'id' in o.op && o.op.id === id && 'base' in o.op && !!o.op.base)
      .modify((o) => {
        const base = (o.op as { base: Record<string, number> }).base;
        for (const f of written) if (f in base) base[f] = Math.max(base[f]!, fieldSeq[f] ?? 0);
        if ('*' in base) base['*'] = Math.max(base['*']!, lastFieldChange(fieldSeq));
      });
  }

  /** Puts the entity as the server has it in the local database (events are read again: the server's answer for them is per person). */
  private async refreshFrom(entity: MergeEntity, id: string, from: SyncEntityDto | undefined): Promise<void> {
    if (from && from.kind === entity) return void (await this.tableOf(entity).put(from.row));
    if (entity === 'task') await this.boards.reloadTask(id);
    if (entity === 'event') await this.calendar.reloadEvent(id);
  }

  /** The op was refused. Changes that lost a merge (or may not be made any more) are kept in the Local history; the rest is dropped as before. */
  private async afterRefused(op: SyncOp, result: Extract<SyncOpResult, { ok: false }>): Promise<number> {
    const kind = mergeKindOf(op);
    const merge = result.error === 'conflict' || result.error === 'target_deleted' || result.error === 'deleted_but_changed';
    if (!kind || !('id' in op) || !(merge || result.error === 'forbidden')) {
      this.dropped(op, result.error);
      return 0;
    }
    const table = this.tableOf(kind.entity);
    const local = await table.get(op.id);
    await this.history.record({
      entity: kind.entity,
      entityId: op.id,
      spaceId: local?.spaceId ?? result.entity?.row.spaceId ?? '',
      op: op.type,
      reason: result.error === 'forbidden' ? 'forbidden' : result.error === 'target_deleted' ? 'target_deleted' : 'conflict',
      fieldsRejected: result.rejected ?? {},
      patch: this.patchOf(op),
      snapshot: local ?? null,
    });
    if (result.error === 'target_deleted') {
      // It is gone online: it goes here too (the copy of this device's version is in the history).
      if (local) await table.update(op.id, { deletedAt: new Date().toISOString() });
    } else {
      // The online version stays: show it as it is.
      await this.refreshFrom(kind.entity, op.id, result.entity);
      if (result.error === 'deleted_but_changed' && local?.['deletedAt'] && !result.entity) await table.update(op.id, { deletedAt: null });
    }
    return 1;
  }

  /** Tells the person once (not every minute) that storage is full and that nothing is lost. */
  private quotaRefused(): void {
    this.refusedThisCycle = true;
    if (!this.quotaNotified) this.addIssue({ messageKey: 'sync.quotaExceeded' });
    this.quotaNotified = true;
    this.quota.markRefused();
  }

  private dropped(op: SyncOp, reason: string): void {
    // A task change the server refused: show the task as the server has it (a move into a full column puts it back).
    if (op.type.startsWith('task.')) {
      const id = op.type === 'task.create' ? op.id : (op as { id: string }).id;
      void this.boards.reloadTask(id);
      if (reason === 'wip_limit') return this.addIssue({ messageKey: 'board.wipRefused' });
    }
    // An event change the server refused: show the event as the server has it.
    if (op.type.startsWith('event.')) {
      void this.calendar.reloadEvent((op as { id: string }).id);
      if (reason === 'forbidden' || reason === 'not_found') return this.addIssue({ messageKey: 'calendar.changeRefused' });
    }
    // not_found for a delete/restore is normal after another device purged the item; everything else the user should hear about.
    if (reason === 'not_found' && /\.(delete|restore)$/.test(op.type)) return;
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
    if (row.notebookId) form.append('notebookId', row.notebookId); // a notebook that is not the person's own names the space the file belongs to
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
      const res = await firstValueFrom(this.http.post<{ ok: true; version: number }>(`/api/pages/${row.id}/snapshots/replace`, { content, baseVersion: row.baseVersion }));
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
    if (!personal) return; // a session restored from before spaces existed: the account is read again first, then this runs

    const stored = ((await db.meta.get('cursors'))?.value as Record<string, number> | undefined) ?? {};
    const cursors: Record<string, number> = { ...stored };
    if (cursors[personal] === undefined) cursors[personal] = ((await db.meta.get('cursor'))?.value as number | undefined) ?? 0; // the single cursor of older versions
    // Read the tables themselves: the live signals may not have caught up with what refreshAll just wrote.
    const spaces = [personal, ...(await db.teams.toArray()).map((t) => t.spaceId), ...(await db.projects.toArray()).map((p) => p.spaceId)];
    for (const id of spaces) cursors[id] ??= 0;
    // Notebooks of a space the person may not see (a notebook overwrite hides them), as of the last answer.
    const hiddenBefore = ((await db.meta.get('hidden'))?.value as Record<string, string[]> | undefined) ?? {};
    // Boards of a space the person may not see (a board overwrite hides them), as of the last answer.
    const hiddenBoardsBefore = ((await db.meta.get('hiddenBoards'))?.value as Record<string, string[]> | undefined) ?? {};

    for (;;) {
      const res = await firstValueFrom(this.http.get<SyncChangesDto>('/api/sync/changes', { params: { cursors: JSON.stringify(cursors) } }));
      let more = false;
      for (const [key, changes] of Object.entries(res.spaces)) {
        await this.apply(changes);
        cursors[key] = changes.cursor;
        more ||= changes.hasMore;
        if (isSharedCursorKey(key)) continue;
        // Notebooks that became hidden or moved away are dropped from this device...
        const hidden = changes.hiddenNotebooks ?? [];
        await this.dropNotebooks([...hidden, ...(changes.movedOut ?? [])], key);
        // ...and when one that was hidden is visible again, nothing else says so: read the space from the start.
        if ((hiddenBefore[key] ?? []).some((id) => !hidden.includes(id))) {
          cursors[key] = 0;
          more = true;
        }
        if (hidden.length) hiddenBefore[key] = hidden;
        else delete hiddenBefore[key];
        // Boards: the same, and tasks that went to another space are dropped here.
        const hiddenBoards = changes.hiddenBoards ?? [];
        await this.boards.dropBoards(hiddenBoards);
        await this.boards.dropTasks(changes.movedOutTasks ?? [], key);
        if ((hiddenBoardsBefore[key] ?? []).some((id) => !hiddenBoards.includes(id))) {
          cursors[key] = 0;
          more = true;
        }
        if (hiddenBoards.length) hiddenBoardsBefore[key] = hiddenBoards;
        else delete hiddenBoardsBefore[key];
      }
      if (res.sharedNotebooks) {
        await db.transaction('rw', db.shared, async () => {
          await db.shared.clear();
          await db.shared.bulkPut(res.sharedNotebooks!);
        });
      }
      const revoked = res.revokedSpaces.filter((id) => !isSharedCursorKey(id));
      if (revoked.length) {
        await this.teamStore.purgeSpaces(revoked);
        // What this device kept of changes and pages in those spaces (the Local history) may hold data the person may no longer see.
        await this.history.purgeSpaces(revoked);
        this.addIssue({ messageKey: 'sync.spaceRevoked' });
      }
      for (const key of res.revokedSpaces) {
        delete cursors[key];
        if (isSharedCursorKey(key)) await this.dropNotebooks([notebookOfSharedKey(key)], null);
      }
      // purgeSpaces rewrites the stored cursors; keep the ones we hold now
      await db.transaction('rw', db.meta, async () => {
        await db.meta.put({ key: 'cursors', value: cursors });
        await db.meta.put({ key: 'hidden', value: hiddenBefore });
        await db.meta.put({ key: 'hiddenBoards', value: hiddenBoardsBefore });
      });
      if (!more) return;
    }
  }

  /**
   * Removes notebooks (with their categories, pages and documents) from this device: they were hidden by an overwrite, moved to
   * another space, or are no longer shared. With `space`, only those still filed under it (one that already arrived under its new
   * space is kept).
   */
  private async dropNotebooks(ids: string[], space: string | null): Promise<void> {
    if (!ids.length) return;
    const db = this.dbs.db;
    await db.transaction('rw', [db.notebooks, db.categories, db.pages, db.contents, db.shared], async () => {
      const doomed = (await db.notebooks.bulkGet(ids)).filter((n): n is NonNullable<typeof n> => !!n && (space === null || n.spaceId === space)).map((n) => n.id);
      if (!doomed.length) return;
      const pageIds = (await db.pages.where('notebookId').anyOf(doomed).primaryKeys()) as string[];
      await db.contents.bulkDelete(pageIds);
      await db.pages.where('notebookId').anyOf(doomed).delete();
      await db.categories.where('notebookId').anyOf(doomed).delete();
      await db.notebooks.bulkDelete(doomed);
      if (space === null) await db.shared.bulkDelete(doomed);
    });
  }

  /** Writes server changes locally, except for things with queued local changes (those are sent first and win). */
  private async apply(changes: SpaceChangesDto): Promise<void> {
    const db = this.dbs.db;
    const leftOut = await this.scope.excludedNow();
    await db.transaction('rw', [db.notebooks, db.categories, db.pages, db.contents, db.outbox, db.boards, db.columns, db.tasks, db.labels, db.events], async () => {
      const protectedIds = new Set((await db.outbox.toArray()).map((o) => ('id' in o.op ? o.op.id : '')));
      // events (one with changes waiting to be sent keeps them until they have gone); the ones the person may not see (any more) are dropped
      if (changes.events?.length) await db.events.bulkPut(changes.events.filter((e) => !protectedIds.has(e.id)));
      if (changes.hiddenEvents?.length) await db.events.bulkDelete(changes.hiddenEvents.filter((id) => !protectedIds.has(id)));
      // boards, columns, tasks and labels (a task with changes waiting to be sent keeps them until they have gone)
      if (changes.boards?.length) await db.boards.bulkPut(changes.boards);
      if (changes.columns?.length) await db.columns.bulkPut(changes.columns);
      if (changes.labels?.length) await db.labels.bulkPut(changes.labels);
      if (changes.tasks?.length) await db.tasks.bulkPut(changes.tasks.filter((t) => !protectedIds.has(t.id)));
      const keep = <T extends { id: string }>(rows: T[]) => rows.filter((r) => !protectedIds.has(r.id));
      await db.notebooks.bulkPut(keep(changes.notebooks));
      await db.categories.bulkPut(keep(changes.categories));
      const pages = keep(changes.pages);
      await db.pages.bulkPut(pages);

      for (const p of pages) {
        if (p.deletedAt || leftOut.has(p.spaceId)) continue; // a space that does not keep page texts offline: they are fetched when opened
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
