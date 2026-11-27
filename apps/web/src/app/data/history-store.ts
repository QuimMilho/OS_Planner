import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import { patchFromFields } from '@os-planner/shared/lite';
import type { BoardDto, CategoryDto, EventDto, MergeEntity, NotebookDto, PageMetaDto, RejectedField, TaskDto } from '@os-planner/shared';
import { Language } from '../core/i18n';
import { Platform } from '../core/platform';
import { uuidv7 } from '../core/ids';
import { BoardStore } from './board-store';
import { CalendarStore } from './calendar-store';
import { Db, type HistoryReason, type LocalHistoryRow } from './db';
import { liveSignal } from './live';
import { Outbox } from './outbox';
import { TeamStore } from './team-store';
import { TreeStore } from './tree-store';

const DAY = 86_400_000;
/** How long an entry is kept unless the person says otherwise (Settings -> Offline), and the most they may ask for. */
export const HISTORY_DAYS_DEFAULT = 30;
export const HISTORY_DAYS_MAX = 90;
/** What one device keeps: this many entries and about this many bytes, oldest purged first. */
export const HISTORY_MAX_ENTRIES = 5000;
export const HISTORY_MAX_BYTES = 50 * 1024 * 1024;
const DAYS_KEY = 'historyDays';

export class HistoryError extends Error {
  constructor(readonly code: 'gone' | 'offline' | 'refused' | 'nothing_to_apply') {
    super(code);
  }
}

export interface RecordInput {
  entity: MergeEntity;
  entityId: string;
  spaceId: string;
  /** The op that was refused (`task.update`), or `page.merge`. */
  op: string;
  reason: HistoryReason;
  fieldsRejected?: Record<string, RejectedField>;
  patch?: Record<string, unknown>;
  /** The entity as this device had it. */
  snapshot: unknown;
  state?: Uint8Array;
}

const titleOf = (entity: MergeEntity, row: unknown): string => {
  const r = (row ?? {}) as { title?: string; name?: string };
  return (entity === 'notebook' || entity === 'category' ? r.name : r.title) ?? '';
};

const sizeOf = (snapshot: unknown, state?: Uint8Array): number => {
  try {
    return JSON.stringify(snapshot ?? null).length * 2 + (state?.byteLength ?? 0) + 400;
  } catch {
    return 400 + (state?.byteLength ?? 0);
  }
};

/**
 * Local history (phase 15): what this device changed offline and the server did not take over as it was. Per device by design
 * (nothing here is synced). Entries are never applied on their own: the person decides, for each, to put their version back
 * (Replace), keep it as a new item (Add as new) or let it go (Dismiss).
 */
@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);
  private readonly outbox = inject(Outbox);
  private readonly lang = inject(Language);
  private readonly platform = inject(Platform);
  private readonly tree = inject(TreeStore);
  private readonly boards = inject(BoardStore);
  private readonly calendar = inject(CalendarStore);
  private readonly teams = inject(TeamStore);

  /** Newest first. */
  readonly entries = liveSignal(this.dbs, (d) => d.localHistory.orderBy('at').reverse().toArray(), [] as LocalHistoryRow[]);
  /** What still waits for a decision. */
  readonly open = computed(() => this.entries().filter((e) => e.resolved === 'none'));
  /** What needs a decision (the badge). The copies of a page kept before a merge are a safety net: listed, but they do not ask for attention. */
  readonly count = computed(() => this.open().filter((e) => e.reason !== 'pre_merge').length);
  readonly bytes = computed(() => this.entries().reduce((n, e) => n + (e.bytes ?? 0), 0));
  /** Days an entry is kept. */
  readonly days = signal(HISTORY_DAYS_DEFAULT);

  /** Reads the settings of the open database. */
  async load(): Promise<void> {
    if (!this.dbs.current()) return;
    const stored = (await this.dbs.db.meta.get(DAYS_KEY))?.value;
    this.days.set(typeof stored === 'number' ? Math.min(HISTORY_DAYS_MAX, Math.max(1, Math.round(stored))) : HISTORY_DAYS_DEFAULT);
  }

  async setDays(days: number): Promise<void> {
    const value = Math.min(HISTORY_DAYS_MAX, Math.max(1, Math.round(days) || HISTORY_DAYS_DEFAULT));
    this.days.set(value);
    const db = this.dbs.db;
    await db.meta.put({ key: DAYS_KEY, value });
    await db.localHistory.toCollection().modify((r) => void (r.expiresAt = r.at + value * DAY));
    await this.purge();
  }

  private device(): string {
    return (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? this.platform.os;
  }

  /** Keeps a change that lost a merge (or a page as it was before one). */
  async record(input: RecordInput): Promise<LocalHistoryRow> {
    const db = this.dbs.db;
    const at = Date.now();
    const row: LocalHistoryRow = {
      id: uuidv7(),
      at,
      createdAt: at,
      device: this.device(),
      entity: input.entity,
      entityId: input.entityId,
      entityTitle: titleOf(input.entity, input.snapshot) || (await this.titleFromTables(input.entity, input.entityId)),
      spaceId: input.spaceId,
      op: input.op,
      fieldsRejected: input.fieldsRejected ?? {},
      patch: input.patch ?? {},
      snapshot: input.snapshot,
      reason: input.reason,
      resolved: 'none',
      expiresAt: at + this.days() * DAY,
      bytes: sizeOf(input.snapshot, input.state) + sizeOf(input.fieldsRejected),
      ...(input.entity === 'page' ? { pageId: input.entityId } : {}),
      ...(input.state ? { state: input.state } : {}),
    };
    await db.localHistory.add(row);
    await this.purge();
    return row;
  }

  private async titleFromTables(entity: MergeEntity, id: string): Promise<string> {
    const db = this.dbs.db;
    const table = { notebook: db.notebooks, category: db.categories, page: db.pages, task: db.tasks, event: db.events }[entity] as { get(id: string): Promise<unknown> };
    return titleOf(entity, await table.get(id));
  }

  /** Drops what is past its time, then the oldest until the history is within its caps. */
  async purge(): Promise<void> {
    if (!this.dbs.current()) return;
    const db = this.dbs.db;
    const now = Date.now();
    const rows = await db.localHistory.orderBy('at').toArray();
    const doomed = new Set(rows.filter((r) => r.expiresAt < now).map((r) => r.id));
    let live = rows.filter((r) => !doomed.has(r.id));
    let bytes = live.reduce((n, r) => n + (r.bytes ?? 0), 0);
    while (live.length && (live.length > HISTORY_MAX_ENTRIES || bytes > HISTORY_MAX_BYTES)) {
      const oldest = live[0]!;
      doomed.add(oldest.id);
      bytes -= oldest.bytes ?? 0;
      live = live.slice(1);
    }
    if (doomed.size) await db.localHistory.bulkDelete([...doomed]);
  }

  async clear(): Promise<void> {
    await this.dbs.db.localHistory.clear();
  }

  /** The person lost access to these spaces: what this device kept of them (changes and page copies) goes too. */
  async purgeSpaces(spaceIds: readonly string[]): Promise<void> {
    if (!spaceIds.length || !this.dbs.current()) return;
    await this.dbs.db.localHistory.where('spaceId').anyOf([...spaceIds]).delete();
  }

  forEntity(entityId: string): LocalHistoryRow[] {
    return this.entries().filter((e) => e.entityId === entityId && e.resolved === 'none');
  }

  /** "Personal", or the name of the team and project a space belongs to. */
  spaceName(spaceId: string): string {
    const project = this.teams.projectBySpace().get(spaceId);
    if (project) return `${this.teams.teamById().get(project.teamId)?.name ?? ''} / ${project.name}`.replace(/^ \/ /, '');
    const team = this.teams.teamBySpace().get(spaceId);
    return team ? team.name : this.lang.t('history.personal');
  }

  // ------------------------------------------------------------------ what the person decides

  async dismiss(entry: LocalHistoryRow): Promise<void> {
    await this.dbs.db.localHistory.update(entry.id, { resolved: 'dismissed' });
  }

  async remove(entry: LocalHistoryRow): Promise<void> {
    await this.dbs.db.localHistory.delete(entry.id);
  }

  /** Whether the thing this entry is about is still there (so Replace makes sense). */
  async exists(entry: LocalHistoryRow): Promise<boolean> {
    const db = this.dbs.db;
    const table = { notebook: db.notebooks, category: db.categories, page: db.pages, task: db.tasks, event: db.events }[entry.entity] as { get(id: string): Promise<{ deletedAt?: string | null } | undefined> };
    const row = await table.get(entry.entityId);
    return !!row && !row.deletedAt;
  }

  /**
   * Puts this device's version back over the online one: the values are sent again as a new change, against what is online *now*
   * (so it wins now, as far as the person's permissions allow). The online values it overwrites are kept as a new entry, so
   * this can be undone the same way.
   */
  async replace(entry: LocalHistoryRow): Promise<void> {
    if (!(await this.exists(entry))) throw new HistoryError('gone');
    const db = this.dbs.db;
    // A page as it was before an offline merge: its document goes back through the server (which keeps the page as it is first).
    if (entry.state && entry.entity === 'page') {
      const { docFromState, yDocToJSON } = await import('@os-planner/shared/collab');
      const content = yDocToJSON(docFromState(entry.state)) as JSONContent;
      try {
        await firstValueFrom(this.http.post(`/api/pages/${entry.entityId}/snapshots/replace`, { content }));
      } catch {
        throw new HistoryError('offline');
      }
      await db.localHistory.update(entry.id, { resolved: 'replaced' });
      return;
    }
    const isDelete = /\.(delete|cancel)$/.test(entry.op);
    const wanted = isDelete ? {} : { ...entry.patch, ...patchFromFields(entry.entity, Object.fromEntries(Object.entries(entry.fieldsRejected).map(([f, v]) => [f, v.mine]))) };
    if (!isDelete && !Object.keys(wanted).length) throw new HistoryError('nothing_to_apply');
    // What is online now, kept before it is overwritten.
    const current = await this.currentRow(entry);
    const overwritten = Object.fromEntries(Object.entries(entry.fieldsRejected).map(([f, v]) => [f, { mine: v.server, server: v.mine, serverSeq: v.serverSeq }]));
    if (Object.keys(overwritten).length && current) {
      await this.record({ entity: entry.entity, entityId: entry.entityId, spaceId: entry.spaceId, op: entry.op, reason: 'conflict', fieldsRejected: overwritten, patch: patchFromFields(entry.entity, Object.fromEntries(Object.entries(overwritten).map(([f, v]) => [f, v.mine]))), snapshot: current });
    }
    await this.applyAgain(entry, wanted, isDelete);
    await db.localHistory.update(entry.id, { resolved: 'replaced' });
  }

  private async currentRow(entry: LocalHistoryRow): Promise<unknown> {
    const db = this.dbs.db;
    return ({ notebook: db.notebooks, category: db.categories, page: db.pages, task: db.tasks, event: db.events }[entry.entity] as { get(id: string): Promise<unknown> }).get(entry.entityId);
  }

  /** The same change as the person would make by hand, through the store that knows what it does locally (it goes out with a fresh base). */
  private async applyAgain(entry: LocalHistoryRow, patch: Record<string, unknown>, isDelete: boolean): Promise<void> {
    const id = entry.entityId;
    switch (entry.entity) {
      case 'task':
        if (isDelete) return this.boards.deleteTask(id);
        // a move (column and place in it) is its own change
        if (typeof patch['columnId'] === 'string' && typeof patch['position'] === 'string') return this.boards.moveTask(id, patch['columnId'], patch['position'], typeof patch['boardId'] === 'string' ? patch['boardId'] : undefined);
        return this.boards.updateTask(id, patch as never);
      case 'event':
        if (isDelete) return this.calendar.cancelEvent(id);
        return this.calendar.updateEvent(id, patch as never);
      case 'notebook':
        if (isDelete) return this.tree.deleteNotebook(id);
        return this.tree.updateNotebook(id, patch as never);
      case 'category':
        if (isDelete) return this.tree.deleteCategory(id);
        return this.tree.updateCategory(id, patch as never);
      case 'page':
        if (isDelete) return this.tree.deletePage(id);
        if (typeof patch['categoryId'] === 'string') return this.tree.movePage(id, patch['categoryId'], typeof patch['position'] === 'string' ? patch['position'] : undefined);
        if (typeof patch['title'] === 'string') return this.tree.renamePage(id, patch['title']);
        return;
    }
  }

  /** Makes this device's version a new item next to the online one (always possible, whatever happened to the original). */
  async addAsNew(entry: LocalHistoryRow): Promise<string> {
    const suffix = ` (${this.lang.t('history.myVersion')})`;
    const snap = (entry.snapshot ?? {}) as Record<string, unknown>;
    // What this device wanted, on top of how it had the item.
    const mine = { ...snap, ...entry.patch, ...patchFromFields(entry.entity, Object.fromEntries(Object.entries(entry.fieldsRejected).map(([f, v]) => [f, v.mine]))) } as Record<string, any>;
    let id = '';
    switch (entry.entity) {
      case 'task': {
        const task = mine as unknown as TaskDto;
        const board = (await this.dbs.db.boards.get(task.boardId)) as BoardDto | undefined;
        if (!board) throw new HistoryError('gone');
        const columns = (await this.dbs.db.columns.where('boardId').equals(board.id).toArray()).filter((c) => !c.deletedAt);
        const column = columns.find((c) => c.id === task.columnId) ?? columns.sort((a, b) => (a.position < b.position ? -1 : 1))[0];
        if (!column) throw new HistoryError('gone');
        const made = await this.boards.createTask(board, column.id, `${task.title}${suffix}`, {
          ...(task.description ? { description: task.description as never } : {}),
          ...(task.priority && task.priority !== 'none' ? { priority: task.priority } : {}),
          ...(task.startAt ? { startAt: task.startAt } : {}),
          ...(task.dueAt ? { dueAt: task.dueAt } : {}),
          ...(task.allDay ? { allDay: true } : {}),
          ...(task.assigneeIds?.length ? { assigneeIds: task.assigneeIds } : {}),
          ...(task.labelIds?.length ? { labelIds: task.labelIds } : {}),
          // checklist items belong to one task: the copy gets items of its own
          ...(task.checklist?.length ? { checklist: task.checklist.map((c) => ({ ...c, id: uuidv7() })) } : {}),
        });
        id = made.id;
        break;
      }
      case 'event': {
        const e = mine as unknown as EventDto;
        const made = await this.calendar.createEvent({
          spaceId: e.spaceId,
          kind: e.kind,
          title: `${e.title}${suffix}`,
          description: e.description,
          location: e.location,
          videoUrl: e.videoUrl,
          startAt: e.startAt,
          endAt: e.endAt,
          allDay: e.allDay,
          timezone: e.timezone,
          rrule: e.rrule,
          visibility: e.visibility,
        } as never);
        id = made.id;
        break;
      }
      case 'notebook': {
        const n = mine as unknown as NotebookDto;
        id = (await this.tree.createNotebook(`${n.name}${suffix}`, n.spaceId)).id;
        break;
      }
      case 'category': {
        const c = mine as unknown as CategoryDto;
        const notebook = await this.dbs.db.notebooks.get(c.notebookId);
        if (!notebook || notebook.deletedAt) throw new HistoryError('gone');
        const parent = c.parentId ? await this.dbs.db.categories.get(c.parentId) : undefined;
        id = (await this.tree.createCategory(c.notebookId, parent && !parent.deletedAt ? parent.id : null, `${c.name}${suffix}`)).id;
        break;
      }
      case 'page': {
        const p = mine as unknown as PageMetaDto;
        const db = this.dbs.db;
        let category = await db.categories.get(p.categoryId);
        if (!category || category.deletedAt) category = (await db.categories.where('notebookId').equals(p.notebookId).filter((c) => !c.deletedAt).first()) ?? undefined;
        if (!category) throw new HistoryError('gone');
        const made = await this.tree.createPage(category.id, `${p.title}${suffix}`);
        id = made.id;
        // The text: the copy kept before the merge, or what this device holds now.
        let content: JSONContent | undefined;
        if (entry.state) {
          const { docFromState, yDocToJSON } = await import('@os-planner/shared/collab');
          content = yDocToJSON(docFromState(entry.state)) as JSONContent;
        } else content = (await db.contents.get(p.id))?.content;
        if (content) {
          await db.contents.put({ id, content, baseVersion: 0, dirty: 1, rev: 1 });
          this.outbox.changed.next();
        }
        break;
      }
    }
    await this.dbs.db.localHistory.update(entry.id, { resolved: 'added' });
    return id;
  }
}
