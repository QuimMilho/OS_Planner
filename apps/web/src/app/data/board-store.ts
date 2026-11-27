import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, computed, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BOARD_EVENTS, comparePositions, hasPermission, Permission, permissionsFromString, positionBetween } from '@os-planner/shared/lite';
import type {
  BoardDetailDto,
  BoardDto,
  BoardMemberDto,
  BoardPermissionsDto,
  ColumnDto,
  CreateBoardInput,
  CreateColumnInput,
  CreateLabelInput,
  DeleteColumnInput,
  LabelDto,
  TaskDocDto,
  TaskDto,
  TaskDetailDto,
  UpdateBoardInput,
  UpdateColumnInput,
  UpdateLabelInput,
  UpdateTaskInput,
  CreateTaskInput,
} from '@os-planner/shared';
import { AuthStore, toProblem } from '../core/auth-store';
import { uuidv7 } from '../core/ids';
import { RealtimeService } from '../core/realtime';
import { Db } from './db';
import { liveSignal } from './live';
import { Outbox } from './outbox';
import { TeamStore } from './team-store';

const PERMS_KEY = 'boardPerms';
const MEMBERS_PREFIX = 'bm:';

/** Why the store refused something locally (the server says the same when asked). */
export class BoardError extends Error {
  constructor(readonly code: 'wip_limit' | 'invalid' | 'not_found' | 'read_only') {
    super(code);
  }
}

/** The calendar day of an all-day value at 00:00 UTC: whatever instant arrives, its UTC date part is the day. */
const allDayDate = (iso: string): string => new Date(Date.UTC(new Date(iso).getUTCFullYear(), new Date(iso).getUTCMonth(), new Date(iso).getUTCDate())).toISOString();

/**
 * Boards, columns, tasks and labels on this device, and the changes a person makes to them.
 *
 * The rows come from sync (and from the board's room while it is open). Work on tasks (create, change, move, delete) is applied
 * here at once and queued for the server like every offline change, so it works without a connection; the server decides when it
 * arrives (a column that is full refuses the move, and the task then shows where it really is). Boards, columns and labels are
 * managed online: the server answers first and the result is written here.
 */
@Injectable({ providedIn: 'root' })
export class BoardStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);
  private readonly outbox = inject(Outbox);
  private readonly auth = inject(AuthStore);
  private readonly rt = inject(RealtimeService);
  private readonly teams = inject(TeamStore);
  private readonly injector = inject(Injector);

  readonly boards = liveSignal(this.dbs, (d) => d.boards.toArray(), [] as BoardDto[]);
  readonly columns = liveSignal(this.dbs, (d) => d.columns.toArray(), [] as ColumnDto[]);
  readonly tasks = liveSignal(this.dbs, (d) => d.tasks.toArray(), [] as TaskDto[]);
  readonly labels = liveSignal(this.dbs, (d) => d.labels.toArray(), [] as LabelDto[]);
  private readonly perms = liveSignal(
    this.dbs,
    async (d) => ((await d.meta.get(PERMS_KEY))?.value ?? { boards: {}, spaces: {} }) as BoardPermissionsDto,
    { boards: {}, spaces: {} } as BoardPermissionsDto,
  );
  private readonly memberRows = liveSignal(
    this.dbs,
    async (d) => Object.fromEntries((await d.meta.filter((m) => m.key.startsWith(MEMBERS_PREFIX)).toArray()).map((m) => [m.key.slice(MEMBERS_PREFIX.length), m.value as BoardMemberDto[]])),
    {} as Record<string, BoardMemberDto[]>,
  );

  readonly liveBoards = computed(() => this.boards().filter((b) => !b.deletedAt));
  readonly boardById = computed(() => new Map(this.boards().map((b) => [b.id, b])));
  readonly taskById = computed(() => new Map(this.tasks().map((t) => [t.id, t])));
  readonly userId = computed(() => this.auth.userId() ?? '');
  private readonly personalSpace = computed(() => this.auth.user()?.personalSpaceId ?? '');

  constructor() {
    // Rows pushed to the room of an open board. The room of a space only says that something changed (Session pulls then).
    this.rt.on<TaskDto | { seq?: number }>(BOARD_EVENTS.taskCreated).subscribe((p) => void this.onTask(p));
    this.rt.on<TaskDto | { seq?: number }>(BOARD_EVENTS.taskUpdated).subscribe((p) => void this.onTask(p));
    this.rt.on<TaskDto | { seq?: number }>(BOARD_EVENTS.taskMoved).subscribe((p) => void this.onTask(p));
    this.rt.on<TaskDto | { seq?: number }>(BOARD_EVENTS.taskDeleted).subscribe((p) => void this.onTask(p));
    this.rt.on<{ board?: BoardDto; columns?: ColumnDto[] }>(BOARD_EVENTS.boardUpdated).subscribe((p) => void this.onBoard(p));
  }

  // ------------------------------------------------------------------ reading

  /** The person's own space: boards there are theirs alone. */
  isPersonalSpace(spaceId: string): boolean {
    return spaceId === this.personalSpace();
  }

  boardsOfSpace(spaceId: string): BoardDto[] {
    return this.liveBoards()
      .filter((b) => b.spaceId === spaceId)
      .sort(comparePositions);
  }

  columnsOf(boardId: string): ColumnDto[] {
    return this.columns()
      .filter((c) => c.boardId === boardId && !c.deletedAt)
      .sort(comparePositions);
  }

  /** The live tasks of a board (subtasks included). */
  tasksOf(boardId: string): TaskDto[] {
    return this.tasks().filter((t) => t.boardId === boardId && !t.deletedAt);
  }

  /** The labels a board may use: its space's own, and the inheritable ones of the spaces above it. */
  labelsFor(spaceId: string): LabelDto[] {
    const above = new Set<string>();
    const place = this.teams.placeOfSpace(spaceId);
    if (place?.team) {
      above.add(place.team.spaceId);
      for (const p of place.projects) above.add(p.spaceId);
    }
    return this.labels()
      .filter((l) => !l.deletedAt && (l.spaceId === spaceId || (above.has(l.spaceId) && l.inheritable)))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }

  /** Who may be assigned on a board: the people the server listed as able to see it (the person alone on a personal board). */
  membersOf(board: BoardDto): BoardMemberDto[] {
    if (board.spaceId === this.personalSpace()) return [{ userId: this.userId(), displayName: this.auth.user()?.displayName ?? '' }];
    const known = this.memberRows()[board.id];
    if (known) return known;
    const place = this.teams.placeOfSpace(board.spaceId);
    return place?.team ? this.teams.membersOf(place.team.id).map((m) => ({ userId: m.userId, displayName: m.nickname || m.displayName })) : [];
  }

  /** The name to show for a person on a board. */
  nameOf(board: BoardDto | undefined, userId: string | null): string {
    if (!userId) return '';
    if (userId === this.userId()) return this.auth.user()?.displayName ?? '';
    const found = board ? this.membersOf(board).find((m) => m.userId === userId) : undefined;
    if (found) return found.displayName;
    for (const m of this.teams.members()) if (m.userId === userId) return m.nickname || m.displayName;
    return '';
  }

  /** Whether the person may do `permission` on the board. A personal board is theirs: everything. Unknown means no. */
  can(boardId: string, permission: bigint): boolean {
    const board = this.boardById().get(boardId);
    if (!board) return false;
    if (board.spaceId === this.personalSpace()) return true;
    const raw = this.perms().boards[boardId];
    const set = raw === undefined ? null : permissionsFromString(raw);
    return set !== null && hasPermission(set, permission);
  }

  /** Whether the person may do `permission` in a space (create boards, manage labels). */
  canIn(spaceId: string, permission: bigint): boolean {
    if (spaceId === this.personalSpace()) return true;
    const raw = this.perms().spaces[spaceId];
    const set = raw === undefined ? null : permissionsFromString(raw);
    return set !== null && hasPermission(set, permission);
  }

  /** Reads what the person may do from the server and keeps it for offline use. */
  async refreshPermissions(): Promise<void> {
    const res = await firstValueFrom(this.http.get<BoardPermissionsDto>('/api/board-permissions'));
    await this.dbs.db.meta.put({ key: PERMS_KEY, value: res });
  }

  // ------------------------------------------------------------------ the server's side

  /** Reads the board with everything on it (and who can be assigned) from the server into this device. */
  async loadBoard(id: string): Promise<BoardDetailDto | null> {
    let detail: BoardDetailDto;
    try {
      detail = await firstValueFrom(this.http.get<BoardDetailDto>(`/api/boards/${id}`));
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 404) return null;
      throw p;
    }
    const db = this.dbs.db;
    await db.transaction('rw', [db.boards, db.columns, db.tasks, db.labels, db.outbox, db.meta], async () => {
      const protectedIds = new Set((await db.outbox.toArray()).map((o) => ('id' in o.op ? o.op.id : '')));
      await db.boards.put(detail.board);
      await db.columns.bulkPut(detail.columns);
      await db.labels.bulkPut(detail.labels);
      await db.tasks.bulkPut(detail.tasks.filter((t) => !protectedIds.has(t.id)));
      await db.meta.put({ key: MEMBERS_PREFIX + id, value: detail.members });
      const perms = ((await db.meta.get(PERMS_KEY))?.value ?? { boards: {}, spaces: {} }) as BoardPermissionsDto;
      await db.meta.put({ key: PERMS_KEY, value: { ...perms, boards: { ...perms.boards, [id]: detail.permissions } } });
    });
    return detail;
  }

  /** Reads one task as the server has it (after the server refused a change of ours, or when a link opens one). */
  async reloadTask(id: string): Promise<TaskDto | null> {
    try {
      const detail = await firstValueFrom(this.http.get<TaskDetailDto>(`/api/tasks/${id}`));
      await this.dbs.db.tasks.bulkPut([detail.task, ...detail.subtasks]);
      return detail.task;
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 404) {
        const row = await this.dbs.db.tasks.get(id);
        if (row && !row.deletedAt) await this.dbs.db.tasks.put({ ...row, deletedAt: new Date().toISOString() });
        return null;
      }
      return null;
    }
  }

  /** The drawer's extras (comments, files, history). Needs a connection. */
  async taskDetail(id: string): Promise<TaskDetailDto> {
    try {
      const detail = await firstValueFrom(this.http.get<TaskDetailDto>(`/api/tasks/${id}`));
      const mine = await this.protectedNow();
      await this.dbs.db.tasks.bulkPut([detail.task, ...detail.subtasks].filter((t) => !mine.has(t.id)));
      return detail;
    } catch (e) {
      throw toProblem(e);
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toProblem(e);
    }
  }

  private sync(): void {
    // Sync injects this store, so it is asked for here and not at construction.
    void import('./sync').then(({ Sync }) => void this.injector.get(Sync).run());
  }

  createBoard(spaceId: string, input: Omit<CreateBoardInput, 'id' | 'position'> & { position?: string }): Promise<BoardDto> {
    return this.call(async () => {
      const last = this.boardsOfSpace(spaceId).at(-1)?.position ?? null;
      const board = await firstValueFrom(this.http.post<BoardDto>(`/api/spaces/${spaceId}/boards`, { id: uuidv7(), position: positionBetween(last, null), ...input }));
      await this.loadBoard(board.id);
      return board;
    });
  }

  updateBoard(id: string, patch: UpdateBoardInput): Promise<BoardDto> {
    return this.call(async () => {
      const board = await firstValueFrom(this.http.patch<BoardDto>(`/api/boards/${id}`, patch));
      await this.dbs.db.boards.put(board);
      return board;
    });
  }

  deleteBoard(id: string): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.delete(`/api/boards/${id}`));
      const db = this.dbs.db;
      const row = await db.boards.get(id);
      if (row) await db.boards.put({ ...row, deletedAt: new Date().toISOString() });
      this.sync();
    });
  }

  duplicateBoard(id: string, withTasks: boolean): Promise<BoardDto> {
    return this.call(async () => {
      const board = await firstValueFrom(this.http.post<BoardDto>(`/api/boards/${id}/duplicate`, { id: uuidv7(), withTasks }));
      await this.loadBoard(board.id);
      return board;
    });
  }

  createColumn(boardId: string, input: Omit<CreateColumnInput, 'id' | 'position'>): Promise<ColumnDto> {
    return this.call(async () => {
      const last = this.columnsOf(boardId).at(-1)?.position ?? null;
      const column = await firstValueFrom(this.http.post<ColumnDto>(`/api/boards/${boardId}/columns`, { id: uuidv7(), position: positionBetween(last, null), ...input }));
      await this.dbs.db.columns.put(column);
      return column;
    });
  }

  updateColumn(id: string, patch: UpdateColumnInput): Promise<ColumnDto> {
    return this.call(async () => {
      const column = await firstValueFrom(this.http.patch<ColumnDto>(`/api/columns/${id}`, patch));
      await this.dbs.db.columns.put(column);
      if (patch.kind !== undefined) this.sync(); // tasks in it were completed or reopened
      return column;
    });
  }

  deleteColumn(id: string, input: DeleteColumnInput): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.delete(`/api/columns/${id}`, { body: input }));
      const db = this.dbs.db;
      const row = await db.columns.get(id);
      if (row) await db.columns.put({ ...row, deletedAt: new Date().toISOString() });
      this.sync();
    });
  }

  createLabel(spaceId: string, input: Omit<CreateLabelInput, 'id'>): Promise<LabelDto> {
    return this.call(async () => {
      const label = await firstValueFrom(this.http.post<LabelDto>(`/api/spaces/${spaceId}/labels`, { id: uuidv7(), ...input }));
      await this.dbs.db.labels.put(label);
      return label;
    });
  }

  updateLabel(id: string, patch: UpdateLabelInput): Promise<LabelDto> {
    return this.call(async () => {
      const label = await firstValueFrom(this.http.patch<LabelDto>(`/api/labels/${id}`, patch));
      await this.dbs.db.labels.put(label);
      if (patch.inheritable === false) this.sync();
      return label;
    });
  }

  deleteLabel(id: string): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.delete(`/api/labels/${id}`));
      const db = this.dbs.db;
      const row = await db.labels.get(id);
      if (row) await db.labels.put({ ...row, deletedAt: new Date().toISOString() });
      await db.tasks.toCollection().modify((t) => {
        if (t.labelIds.includes(id)) t.labelIds = t.labelIds.filter((l) => l !== id);
      });
      this.sync();
    });
  }

  /** The trashed tasks of a board (online). */
  trash(boardId: string): Promise<TaskDto[]> {
    return this.call(() => firstValueFrom(this.http.get<TaskDto[]>(`/api/boards/${boardId}/trash`)));
  }

  purgeTask(id: string): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.delete(`/api/tasks/${id}/purge`));
      await this.dbs.db.tasks.where('id').equals(id).delete();
    });
  }

  // ------------------------------------------------------------------ tasks (offline-capable)

  /** The column the person's task lands in when it is finished (the board's first "done" column), or null. */
  private doneColumn(boardId: string): ColumnDto | null {
    return this.columnsOf(boardId).find((c) => c.kind === 'done') ?? null;
  }

  /** True when the column cannot take another task (subtasks do not count). */
  wipFull(columnId: string, exceptTaskId?: string): boolean {
    const column = this.columns().find((c) => c.id === columnId);
    if (!column?.wipLimit) return false;
    const n = this.tasks().filter((t) => t.columnId === columnId && !t.deletedAt && !t.parentTaskId && t.id !== exceptTaskId).length;
    return n >= column.wipLimit;
  }

  /** The key for a task dropped at `index` among the tasks of a column (or of a parent), not counting the dragged one. */
  positionAt(boardId: string, columnId: string, index: number, parentTaskId: string | null, exceptTaskId?: string): string {
    const siblings = this.tasks()
      .filter((t) => t.boardId === boardId && !t.deletedAt && t.id !== exceptTaskId && (parentTaskId ? t.parentTaskId === parentTaskId : t.columnId === columnId && !t.parentTaskId))
      .sort(comparePositions);
    const before = siblings[index - 1]?.position ?? null;
    const after = siblings[index]?.position ?? null;
    try {
      return positionBetween(before, after);
    } catch {
      return positionBetween(before, null); // two neighbours with the same key: the server tells them apart later
    }
  }

  async createTask(board: BoardDto, columnId: string, title: string, extra: Partial<Omit<CreateTaskInput, 'id' | 'columnId' | 'title' | 'position'>> = {}): Promise<TaskDto> {
    if (!this.can(board.id, Permission.CREATE_TASKS)) throw new BoardError('read_only');
    const column = this.columns().find((c) => c.id === columnId && !c.deletedAt);
    if (!column) throw new BoardError('not_found');
    const parent = extra.parentTaskId ? this.taskById().get(extra.parentTaskId) : undefined;
    if (!parent && this.wipFull(columnId)) throw new BoardError('wip_limit');
    const now = new Date().toISOString();
    const position = this.positionAt(board.id, columnId, Number.MAX_SAFE_INTEGER, parent?.id ?? null);
    const id = uuidv7();
    const allDay = extra.allDay ?? false;
    const row: TaskDto = {
      id,
      boardId: board.id,
      columnId: parent ? parent.columnId : columnId,
      spaceId: board.spaceId,
      parentTaskId: parent?.id ?? null,
      title: title.trim(),
      description: (extra.description as TaskDocDto | null | undefined) ?? null,
      position,
      priority: extra.priority ?? 'none',
      startAt: extra.startAt ? (allDay ? allDayDate(extra.startAt) : extra.startAt) : null,
      dueAt: extra.dueAt ? (allDay ? allDayDate(extra.dueAt) : extra.dueAt) : null,
      allDay,
      completedAt: !parent && column.kind === 'done' ? now : extra.completed ? now : null,
      assigneeIds: extra.assigneeIds ?? [],
      labelIds: extra.labelIds ?? [],
      checklist: extra.checklist ?? [],
      commentCount: 0,
      attachmentCount: 0,
      createdBy: this.userId(),
      createdAt: now,
      updatedAt: now,
      seq: 0,
      deletedAt: null,
    };
    await this.dbs.db.tasks.put(row);
    await this.outbox.enqueue({
      opId: uuidv7(),
      type: 'task.create',
      boardId: board.id,
      id,
      columnId,
      position,
      title: row.title,
      ...(parent ? { parentTaskId: parent.id } : {}),
      ...(extra.description !== undefined ? { description: extra.description } : {}),
      ...(extra.priority ? { priority: extra.priority } : {}),
      ...(extra.startAt ? { startAt: extra.startAt } : {}),
      ...(extra.dueAt ? { dueAt: extra.dueAt } : {}),
      ...(extra.allDay ? { allDay: true } : {}),
      ...(extra.assigneeIds?.length ? { assigneeIds: extra.assigneeIds } : {}),
      ...(extra.labelIds?.length ? { labelIds: extra.labelIds } : {}),
      ...(extra.checklist?.length ? { checklist: extra.checklist } : {}),
    } as never);
    return row;
  }

  /** Changes a task here at once and queues the change for the server. */
  async updateTask(id: string, patch: UpdateTaskInput): Promise<void> {
    const db = this.dbs.db;
    const row = await db.tasks.get(id);
    if (!row) throw new BoardError('not_found');
    const next: TaskDto = { ...row, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.description !== undefined) next.description = patch.description as TaskDocDto | null;
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.allDay !== undefined) next.allDay = patch.allDay;
    const flat = (v: string | null | undefined, current: string | null) => (v === undefined ? current : v === null ? null : next.allDay ? allDayDate(v) : v);
    next.startAt = flat(patch.startAt, row.startAt);
    next.dueAt = flat(patch.dueAt, row.dueAt);
    if (patch.allDay !== undefined && patch.startAt === undefined && next.startAt) next.startAt = next.allDay ? allDayDate(next.startAt) : next.startAt;
    if (patch.allDay !== undefined && patch.dueAt === undefined && next.dueAt) next.dueAt = next.allDay ? allDayDate(next.dueAt) : next.dueAt;
    if (patch.assigneeIds !== undefined) next.assigneeIds = [...new Set(patch.assigneeIds)];
    if (patch.labelIds !== undefined) next.labelIds = [...new Set(patch.labelIds)];
    if (patch.checklist !== undefined) next.checklist = patch.checklist.map((c) => ({ ...c, text: c.text.trim() })).sort(comparePositions);
    let moved: { columnId: string; position: string } | null = null;
    if (patch.completed !== undefined && patch.completed !== !!row.completedAt) {
      next.completedAt = patch.completed ? next.updatedAt : null;
      // Finishing a task puts it in the Done column, reopening it takes it out (the server does the same).
      if (!row.parentTaskId) {
        const columns = this.columnsOf(row.boardId);
        const current = columns.find((c) => c.id === row.columnId);
        const target = patch.completed ? (current?.kind !== 'done' ? this.doneColumn(row.boardId) : null) : current?.kind === 'done' ? (columns.find((c) => c.kind === 'todo') ?? columns.find((c) => c.kind !== 'done') ?? null) : null;
        if (target && !this.wipFull(target.id, id)) {
          moved = { columnId: target.id, position: this.positionAt(row.boardId, target.id, Number.MAX_SAFE_INTEGER, null, id) };
          next.columnId = moved.columnId;
          next.position = moved.position;
        }
      }
    }
    await db.transaction('rw', db.tasks, async () => {
      await db.tasks.put(next);
      if (moved) await db.tasks.where('parentTaskId').equals(id).modify({ columnId: moved.columnId });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'task.update', id, ...patch } as never);
  }

  /** Moves a task to a column (and a place in it), on this board or another; refused here when the column is full. */
  async moveTask(id: string, columnId: string, position: string, boardId?: string): Promise<void> {
    const db = this.dbs.db;
    const row = await db.tasks.get(id);
    const column = this.columns().find((c) => c.id === columnId && !c.deletedAt);
    if (!row || !column) throw new BoardError('not_found');
    if (row.parentTaskId) throw new BoardError('invalid');
    if (columnId !== row.columnId && this.wipFull(columnId, id)) throw new BoardError('wip_limit');
    const old = this.columns().find((c) => c.id === row.columnId);
    const now = new Date().toISOString();
    const target = boardId && boardId !== row.boardId ? this.boardById().get(boardId) : undefined;
    const next: TaskDto = {
      ...row,
      columnId,
      position,
      updatedAt: now,
      ...(target ? { boardId: target.id, spaceId: target.spaceId } : {}),
      completedAt: column.kind === 'done' ? (row.completedAt ?? now) : old?.kind === 'done' ? null : row.completedAt,
    };
    await db.transaction('rw', db.tasks, async () => {
      await db.tasks.put(next);
      await db.tasks.where('parentTaskId').equals(id).modify({ columnId, ...(target ? { boardId: target.id, spaceId: target.spaceId } : {}) });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'task.move', id, columnId, position, ...(target ? { boardId: target.id } : {}) } as never);
  }

  async deleteTask(id: string): Promise<void> {
    const db = this.dbs.db;
    const stamp = new Date().toISOString();
    await db.transaction('rw', db.tasks, async () => {
      await db.tasks.where('id').equals(id).modify({ deletedAt: stamp });
      await db.tasks.where('parentTaskId').equals(id).modify((t) => {
        if (!t.deletedAt) t.deletedAt = stamp;
      });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'task.delete', id });
  }

  async restoreTask(id: string): Promise<void> {
    await this.outbox.enqueue({ opId: uuidv7(), type: 'task.restore', id });
    this.sync();
  }

  // ------------------------------------------------------------------ what arrives from the server

  private async protectedNow(): Promise<Set<string>> {
    return new Set((await this.dbs.db.outbox.toArray()).map((o) => ('id' in o.op ? o.op.id : '')));
  }

  private async onTask(p: TaskDto | { seq?: number }): Promise<void> {
    // The room of the board sends the row; the room of the space sends only where and what changed (no title).
    if (!p || !('title' in p) || !this.dbs.current()) return;
    const db = this.dbs.db;
    if ((await this.protectedNow()).has(p.id)) return;
    const mine = await db.tasks.get(p.id);
    if (mine && mine.seq > p.seq) return;
    await db.tasks.put(p);
  }

  private async onBoard(p: { board?: BoardDto; columns?: ColumnDto[] }): Promise<void> {
    if (!p?.board || !this.dbs.current()) return;
    const db = this.dbs.db;
    await db.transaction('rw', db.boards, db.columns, async () => {
      await db.boards.put(p.board!);
      if (p.columns?.length) await db.columns.bulkPut(p.columns);
    });
  }

  /** Joins the room of a board for as long as it is open. Returns the function that leaves it. */
  open(boardId: string): () => void {
    return this.rt.join('board', boardId);
  }

  /** Boards the person may no longer see: forget them with their columns and tasks. */
  async dropBoards(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const db = this.dbs.db;
    await db.transaction('rw', db.boards, db.columns, db.tasks, async () => {
      await db.tasks.where('boardId').anyOf(ids).delete();
      await db.columns.where('boardId').anyOf(ids).delete();
      await db.boards.bulkDelete(ids);
    });
  }

  /** Tasks that moved to another space: dropped from this one unless they already arrived under the new space. */
  async dropTasks(ids: string[], spaceKey: string): Promise<void> {
    if (!ids.length) return;
    const db = this.dbs.db;
    const doomed = (await db.tasks.bulkGet(ids)).filter((t): t is TaskDto => !!t && t.spaceId === spaceKey).map((t) => t.id);
    if (doomed.length) await db.tasks.bulkDelete(doomed);
  }
}
