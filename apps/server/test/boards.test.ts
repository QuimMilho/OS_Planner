import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOARD_EVENTS,
  Permission,
  permissionsToString,
  positionBetween,
  type BoardDetailDto,
  type BoardDto,
  type SyncChangesDto,
  type TaskDetailDto,
  type TaskDto,
} from '@os-planner/shared';
import { BOARD_LIMITS, taskDocFromText } from '@os-planner/shared/boards';
import { BoardsMaintenance } from '../src/boards/boards.maintenance.js';
import { StorageService } from '../src/media/storage.service.js';
import { createTestApp, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { personalSpaceId, signup, usedBytes, uuid, type Account } from './helpers.js';
import { ack, closeSockets, collect, connect, listen, sleep } from './sockets.js';

const P = Permission;
const ADMIN_EMAIL = `boards-admin${Date.now()}@example.com`;

let t: TestApp;
let url: string;
let saved: string | undefined;
let admin: Account;
let owner: Account;
let member: Account;
let other: Account;
let outsider: Account;

beforeAll(async () => {
  saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  t = await createTestApp();
  url = await listen(t);
});
afterAll(async () => {
  closeSockets();
  await t.close();
  if (saved === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = saved;
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.quotaOverride.deleteMany();
  await t.prisma.user.deleteMany();
  admin = await signup(t, true, ADMIN_EMAIL);
  owner = await signup(t);
  member = await signup(t);
  other = await signup(t);
  outsider = await signup(t);
});
afterEach(() => closeSockets());

// ------------------------------------------------------------------ helpers

interface Team {
  id: string;
  spaceId: string;
}

async function newTeam(members: Account[] = [member, other]): Promise<Team> {
  const res = await t.http.post('/api/admin/teams').set(admin.auth).send({ name: 'Planners', ownerEmail: owner.email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const m of members) await t.prisma.teamMember.create({ data: { teamId: res.body.id, userId: m.id } });
  const row = await t.prisma.team.findUniqueOrThrow({ where: { id: res.body.id } });
  return { id: row.id, spaceId: row.spaceId };
}

let lastPos: string | null = null;
const nextPos = (): string => (lastPos = positionBetween(lastPos, null));

async function newBoard(who: Account, spaceId: string, body: object = {}): Promise<BoardDto> {
  const res = await t.http.post(`/api/spaces/${spaceId}/boards`).set(who.auth).send({ id: uuid(), name: 'Board', position: nextPos(), ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as BoardDto;
}

const detail = async (who: Account, boardId: string): Promise<BoardDetailDto> => {
  const res = await t.http.get(`/api/boards/${boardId}`).set(who.auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as BoardDetailDto;
};

const columnsOf = async (who: Account, boardId: string) => {
  const d = await detail(who, boardId);
  const by = (kind: string) => d.columns.find((c) => c.kind === kind)!;
  return { todo: by('todo'), doing: by('doing'), done: by('done'), all: d.columns };
};

const taskRes = (who: Account, boardId: string, columnId: string, body: object = {}) =>
  t.http.post(`/api/boards/${boardId}/tasks`).set(who.auth).send({ id: uuid(), columnId, position: nextPos(), title: 'Task', ...body });

async function newTask(who: Account, boardId: string, columnId: string, body: object = {}): Promise<TaskDto> {
  const res = await taskRes(who, boardId, columnId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as TaskDto;
}

const patchTask = (who: Account, id: string, body: object) => t.http.patch(`/api/tasks/${id}`).set(who.auth).send(body);
const moveTask = (who: Account, id: string, columnId: string, position = nextPos(), extra: object = {}) =>
  t.http.post(`/api/tasks/${id}/move`).set(who.auth).send({ columnId, position, ...extra });
const getTask = async (who: Account, id: string): Promise<TaskDetailDto> => {
  const res = await t.http.get(`/api/tasks/${id}`).set(who.auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as TaskDetailDto;
};
const rawTask = (id: string) => t.prisma.task.findUniqueOrThrow({ where: { id } });

/** Gives `who` a team role holding `bits` (on top of what everybody has). */
async function giveRole(team: Team, who: Account, bits: bigint): Promise<string> {
  const res = await t.http.post(`/api/teams/${team.id}/roles`).set(owner.auth).send({ name: `role${Math.random().toString(36).slice(2, 8)}`, permissions: permissionsToString(bits) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const put = await t.http.put(`/api/teams/${team.id}/members/${who.id}/roles/${res.body.id}`).set(owner.auth);
  expect(put.status, JSON.stringify(put.body)).toBe(204);
  return res.body.id as string;
}

const overwrite = (who: Account, boardId: string, subject: Account, allow: bigint, deny: bigint) =>
  t.http.put('/api/overwrites').set(who.auth).send({
    targetKind: 'board',
    targetId: boardId,
    subjectKind: 'member',
    subjectId: subject.id,
    allow: permissionsToString(allow),
    deny: permissionsToString(deny),
  });

const changes = async (who: Account, cursors: Record<string, number>): Promise<SyncChangesDto> => {
  const res = await t.http.get('/api/sync/changes').set(who.auth).query({ cursors: JSON.stringify(cursors) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SyncChangesDto;
};

const createProject = async (who: Account, teamId: string, parentId: string | null = null) => {
  const res = await t.http.post(`/api/teams/${teamId}/projects`).set(who.auth).send({ name: 'Project', parentId, position: nextPos() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; spaceId: string };
};

// ------------------------------------------------------------------ boards and columns

describe('boards and columns', () => {
  it('a new board gets To do, Doing and Done; its detail carries columns, tasks, labels, who can be assigned and my permissions', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId, { description: 'Sprint 1' });
    const d = await detail(member, board.id);
    expect(d.board).toMatchObject({ id: board.id, name: 'Board', description: 'Sprint 1', spaceId: team.spaceId, deletedAt: null, archivedAt: null });
    expect(d.columns.map((c) => c.kind)).toEqual(['todo', 'doing', 'done']);
    expect(d.tasks).toEqual([]);
    expect(d.members.map((m) => m.userId).sort()).toEqual([owner.id, member.id, other.id].sort());
    expect(BigInt(d.permissions) & P.VIEW_BOARDS).toBe(P.VIEW_BOARDS);
    expect(BigInt(d.permissions) & P.CREATE_TASKS).toBe(0n);
    // the same id again is the same board (an idempotent create)
    const again = await t.http.post(`/api/spaces/${team.spaceId}/boards`).set(owner.auth).send({ id: board.id, name: 'Other', position: nextPos() });
    expect(again.status).toBe(201);
    expect(again.body.name).toBe('Board');
    expect((await t.http.get(`/api/spaces/${team.spaceId}/boards`).set(member.auth)).body).toHaveLength(1);
  });

  it('columns can be added, limited, reordered and deleted (the tasks go to the column you name); the last one stays', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const added = await t.http.post(`/api/boards/${board.id}/columns`).set(owner.auth).send({ id: uuid(), name: 'Review', position: nextPos(), wipLimit: 3, color: '#3366ff' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ name: 'Review', wipLimit: 3, kind: 'custom' });
    const task = await newTask(owner, board.id, cols.todo.id);
    // a column with tasks cannot go without saying where they go
    expect((await t.http.delete(`/api/columns/${cols.todo.id}`).set(owner.auth).send({})).status).toBe(422);
    const del = await t.http.delete(`/api/columns/${cols.todo.id}`).set(owner.auth).send({ moveTo: cols.doing.id });
    expect(del.status).toBe(204);
    expect((await rawTask(task.id)).columnId).toBe(cols.doing.id);
    const left = (await detail(owner, board.id)).columns;
    expect(left.map((c) => c.name)).toEqual(['Doing', 'Done', 'Review']);
    // reorder
    const first = positionBetween(null, left[0]!.position);
    expect((await t.http.patch(`/api/columns/${added.body.id}`).set(owner.auth).send({ position: first })).status).toBe(200);
    expect((await detail(owner, board.id)).columns[0]!.name).toBe('Review');
    // never the last column
    for (const c of (await detail(owner, board.id)).columns.slice(0, 2)) expect((await t.http.delete(`/api/columns/${c.id}`).set(owner.auth).send({ moveTo: left[0]!.id === c.id ? left[1]!.id : left[0]!.id })).status).toBe(204);
    const last = (await detail(owner, board.id)).columns;
    expect(last).toHaveLength(1);
    expect((await t.http.delete(`/api/columns/${last[0]!.id}`).set(owner.auth).send({ moveTo: uuid() })).status).toBe(422);
  });

  it('a board is renamed, archived (no more changes), duplicated with or without its tasks, trashed and restored', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id, { title: 'Write docs', checklist: [{ id: uuid(), text: 'outline', done: true, position: 'a0' }] });
    expect((await t.http.patch(`/api/boards/${board.id}`).set(owner.auth).send({ name: 'Renamed' })).body.name).toBe('Renamed');

    const copy = await t.http.post(`/api/boards/${board.id}/duplicate`).set(owner.auth).send({ id: uuid(), withTasks: true });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const copied = await detail(owner, copy.body.id);
    expect(copied.columns.map((c) => c.name)).toEqual(['To do', 'Doing', 'Done']);
    expect(copied.tasks.map((x) => x.title)).toEqual(['Write docs']);
    expect(copied.tasks[0]!.id).not.toBe(task.id);
    expect(copied.tasks[0]!.checklist.map((c) => c.done)).toEqual([false]); // a fresh checklist
    const bare = await t.http.post(`/api/boards/${board.id}/duplicate`).set(owner.auth).send({ id: uuid() });
    expect((await detail(owner, bare.body.id)).tasks).toEqual([]);

    expect((await t.http.patch(`/api/boards/${board.id}`).set(owner.auth).send({ archived: true })).body.archivedAt).toBeTruthy();
    expect((await patchTask(owner, task.id, { title: 'nope' })).status).toBe(422);
    expect((await taskRes(owner, board.id, cols.todo.id)).status).toBe(422);
    expect((await t.http.get(`/api/boards/${board.id}`).set(member.auth)).status).toBe(200); // still readable
    await t.http.patch(`/api/boards/${board.id}`).set(owner.auth).send({ archived: false });

    expect((await t.http.delete(`/api/boards/${board.id}`).set(owner.auth)).status).toBe(204);
    expect((await t.http.get(`/api/boards/${board.id}`).set(owner.auth)).status).toBe(404);
    expect((await t.http.get(`/api/spaces/${team.spaceId}/boards`).set(owner.auth)).body.map((b: BoardDto) => b.id)).not.toContain(board.id);
    expect((await t.http.post(`/api/boards/${board.id}/restore`).set(owner.auth)).status).toBe(200);
    expect((await detail(owner, board.id)).tasks.map((x) => x.id)).toEqual([task.id]);
  });
});

// ------------------------------------------------------------------ 1. permissions

describe('permissions', () => {
  it('each bit opens exactly its endpoints: allowed, denied (403), and for someone outside the team 404 everywhere', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id, { title: 'Owner task' });
    const label = (await t.http.post(`/api/spaces/${team.spaceId}/labels`).set(owner.auth).send({ id: uuid(), name: 'bug', color: '#ff0000' })).body;
    const comment = (await t.http.post(`/api/tasks/${task.id}/comments`).set(owner.auth).send({ id: uuid(), content: 'first' })).body;

    // ---- somebody outside the team sees nothing: 404 for every one
    const gone = [
      t.http.get(`/api/spaces/${team.spaceId}/boards`).set(outsider.auth),
      t.http.post(`/api/spaces/${team.spaceId}/boards`).set(outsider.auth).send({ id: uuid(), name: 'x', position: 'a0' }),
      t.http.get(`/api/boards/${board.id}`).set(outsider.auth),
      t.http.patch(`/api/boards/${board.id}`).set(outsider.auth).send({ name: 'x' }),
      t.http.delete(`/api/boards/${board.id}`).set(outsider.auth),
      t.http.post(`/api/boards/${board.id}/duplicate`).set(outsider.auth).send({ id: uuid() }),
      t.http.post(`/api/boards/${board.id}/columns`).set(outsider.auth).send({ id: uuid(), name: 'x', position: 'a0' }),
      t.http.patch(`/api/columns/${cols.todo.id}`).set(outsider.auth).send({ name: 'x' }),
      t.http.post(`/api/boards/${board.id}/tasks`).set(outsider.auth).send({ id: uuid(), columnId: cols.todo.id, position: 'a0', title: 'x' }),
      t.http.get(`/api/tasks/${task.id}`).set(outsider.auth),
      t.http.patch(`/api/tasks/${task.id}`).set(outsider.auth).send({ title: 'x' }),
      moveTask(outsider, task.id, cols.doing.id),
      t.http.delete(`/api/tasks/${task.id}`).set(outsider.auth),
      t.http.put(`/api/tasks/${task.id}/assignees/${member.id}`).set(outsider.auth),
      t.http.put(`/api/tasks/${task.id}/labels/${label.id}`).set(outsider.auth),
      t.http.get(`/api/tasks/${task.id}/activity`).set(outsider.auth),
      t.http.post(`/api/tasks/${task.id}/comments`).set(outsider.auth).send({ id: uuid(), content: 'x' }),
      t.http.patch(`/api/comments/${comment.id}`).set(outsider.auth).send({ content: 'x' }),
      t.http.delete(`/api/comments/${comment.id}`).set(outsider.auth),
      t.http.post(`/api/tasks/${task.id}/attachments`).set(outsider.auth).field('id', uuid()).attach('file', await png(), 'a.png'),
      t.http.get(`/api/spaces/${team.spaceId}/labels`).set(outsider.auth),
      t.http.post(`/api/spaces/${team.spaceId}/labels`).set(outsider.auth).send({ id: uuid(), name: 'x', color: '#00ff00' }),
      t.http.patch(`/api/labels/${label.id}`).set(outsider.auth).send({ name: 'x' }),
      t.http.get(`/api/spaces/${team.spaceId}/tasks`).set(outsider.auth),
      t.http.get(`/api/boards/${board.id}/trash`).set(outsider.auth),
    ];
    for (const [i, res] of (await Promise.all(gone)).entries()) expect(res.status, `outsider call #${i}`).toBe(404);

    // ---- a plain member (VIEW_BOARDS only) may read, nothing else: 403
    expect((await t.http.get(`/api/boards/${board.id}`).set(member.auth)).status).toBe(200);
    expect((await t.http.get(`/api/tasks/${task.id}`).set(member.auth)).status).toBe(200);
    expect((await t.http.get(`/api/spaces/${team.spaceId}/labels`).set(member.auth)).status).toBe(200);
    const denied = [
      t.http.post(`/api/spaces/${team.spaceId}/boards`).set(member.auth).send({ id: uuid(), name: 'x', position: 'a0' }), // MANAGE_BOARDS
      t.http.patch(`/api/boards/${board.id}`).set(member.auth).send({ name: 'x' }),
      t.http.post(`/api/boards/${board.id}/columns`).set(member.auth).send({ id: uuid(), name: 'x', position: 'a0' }),
      t.http.patch(`/api/columns/${cols.todo.id}`).set(member.auth).send({ name: 'x' }),
      t.http.post(`/api/boards/${board.id}/tasks`).set(member.auth).send({ id: uuid(), columnId: cols.todo.id, position: 'a0', title: 'x' }), // CREATE_TASKS
      patchTask(member, task.id, { title: 'x' }), // EDIT_TASKS
      moveTask(member, task.id, cols.doing.id),
      t.http.delete(`/api/tasks/${task.id}`).set(member.auth),
      t.http.put(`/api/tasks/${task.id}/assignees/${member.id}`).set(member.auth), // ASSIGN_TASKS
      t.http.post(`/api/tasks/${task.id}/comments`).set(member.auth).send({ id: uuid(), content: 'x' }),
      t.http.post(`/api/spaces/${team.spaceId}/labels`).set(member.auth).send({ id: uuid(), name: 'x', color: '#00ff00' }), // MANAGE_LABELS
      t.http.patch(`/api/labels/${label.id}`).set(member.auth).send({ name: 'x' }),
      t.http.delete(`/api/labels/${label.id}`).set(member.auth),
      t.http.delete(`/api/comments/${comment.id}`).set(member.auth),
    ];
    for (const [i, res] of (await Promise.all(denied)).entries()) expect(res.status, `member call #${i}`).toBe(403);

    // ---- CREATE_TASKS: add tasks, comment, change what is yours; not other people's, and not assignments
    await giveRole(team, member, P.CREATE_TASKS);
    const mine = await newTask(member, board.id, cols.todo.id, { title: 'Mine' });
    expect((await patchTask(member, mine.id, { title: 'Mine, renamed', description: taskDocFromText('details') })).status).toBe(200); // own title/description
    expect((await patchTask(member, mine.id, { priority: 'high' })).status).toBe(403); // not an "own" field
    expect((await patchTask(member, task.id, { title: 'Theirs' })).status).toBe(403);
    expect((await taskRes(member, board.id, cols.todo.id, { assigneeIds: [member.id] })).status).toBe(403); // ASSIGN_TASKS
    expect((await t.http.post(`/api/tasks/${task.id}/comments`).set(member.auth).send({ id: uuid(), content: 'mine too' })).status).toBe(201);
    expect((await t.http.delete(`/api/tasks/${task.id}`).set(member.auth)).status).toBe(403);
    expect((await t.http.delete(`/api/tasks/${mine.id}`).set(member.auth)).status).toBe(204); // the one who made it may remove it

    // ---- ASSIGN_TASKS
    await giveRole(team, other, P.ASSIGN_TASKS);
    expect((await t.http.put(`/api/tasks/${task.id}/assignees/${member.id}`).set(other.auth)).status).toBe(200);
    expect((await t.http.delete(`/api/tasks/${task.id}/assignees/${member.id}`).set(other.auth)).status).toBe(200);
    expect((await patchTask(other, task.id, { priority: 'urgent' })).status).toBe(403); // assigning is not editing

    // ---- EDIT_TASKS: any task, any field, move, delete, and comments of others
    await giveRole(team, other, P.EDIT_TASKS);
    expect((await patchTask(other, task.id, { priority: 'urgent', title: 'Edited' })).status).toBe(200);
    expect((await moveTask(other, task.id, cols.doing.id)).status).toBe(200);
    expect((await t.http.delete(`/api/comments/${comment.id}`).set(other.auth)).status).toBe(204);
    expect((await t.http.delete(`/api/tasks/${task.id}`).set(other.auth)).status).toBe(204);

    // ---- MANAGE_BOARDS / MANAGE_LABELS
    await giveRole(team, member, P.MANAGE_BOARDS | P.MANAGE_LABELS);
    const second = await newBoard(member, team.spaceId, { name: 'Second' });
    expect((await t.http.patch(`/api/columns/${(await columnsOf(member, second.id)).todo.id}`).set(member.auth).send({ wipLimit: 2 })).status).toBe(200);
    expect((await t.http.patch(`/api/labels/${label.id}`).set(member.auth).send({ name: 'defect' })).body.name).toBe('defect');
    expect((await t.http.delete(`/api/labels/${label.id}`).set(member.auth)).status).toBe(204);
    expect((await t.http.delete(`/api/boards/${second.id}`).set(member.auth)).status).toBe(204);
  });

  it('a person who works on a task changes its title, description, checklist and done state without EDIT_TASKS', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id, { assigneeIds: [member.id] });
    expect((await patchTask(member, task.id, { title: 'Doing it' })).status).toBe(200);
    expect((await patchTask(member, task.id, { checklist: [{ id: uuid(), text: 'step', done: false, position: 'a0' }] })).status).toBe(200);
    const done = await patchTask(member, task.id, { completed: true });
    expect(done.status).toBe(200);
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.columnId).toBe(cols.done.id); // finishing moves it to the Done column
    expect((await patchTask(member, task.id, { completed: false })).body.columnId).toBe(cols.todo.id);
    expect((await patchTask(member, task.id, { priority: 'low' })).status).toBe(403);
    expect((await patchTask(member, task.id, { assigneeIds: [] })).status).toBe(403);
    // somebody who neither made it nor works on it may not
    expect((await patchTask(other, task.id, { title: 'mine now' })).status).toBe(403);
  });

  it('a personal board is its owner\'s alone: the others get 404, never 403', async () => {
    const space = await personalSpaceId(t, owner.id);
    const board = await newBoard(owner, space);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id, { title: 'private' });
    for (const who of [member, outsider]) {
      expect((await t.http.get(`/api/spaces/${space}/boards`).set(who.auth)).status).toBe(404);
      expect((await t.http.get(`/api/boards/${board.id}`).set(who.auth)).status).toBe(404);
      expect((await t.http.get(`/api/tasks/${task.id}`).set(who.auth)).status).toBe(404);
      expect((await t.http.get(`/api/spaces/${space}/tasks`).set(who.auth)).status).toBe(404);
      expect((await patchTask(who, task.id, { title: 'x' })).status).toBe(404);
    }
    // nobody can be assigned but the owner
    const res = await patchTask(owner, task.id, { assigneeIds: [member.id] });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('assignee_cannot_view');
    expect((await patchTask(owner, task.id, { assigneeIds: [owner.id] })).status).toBe(200);
    // and a personal board has no overwrites to set
    expect((await overwrite(owner, board.id, member, P.EDIT_TASKS, 0n)).status).toBe(422);
  });

  it('overwrites on one board change what a member may do there, hide it, and disappear with a deny of VIEW_BOARDS', async () => {
    const team = await newTeam();
    const a = await newBoard(owner, team.spaceId, { name: 'A' });
    const b = await newBoard(owner, team.spaceId, { name: 'B' });
    const colsA = await columnsOf(owner, a.id);
    // allow creating tasks on A only
    expect((await overwrite(owner, a.id, member, P.CREATE_TASKS, 0n)).status).toBe(200);
    expect((await taskRes(member, a.id, colsA.todo.id)).status).toBe(201);
    expect((await taskRes(member, b.id, (await columnsOf(owner, b.id)).todo.id)).status).toBe(403);
    // hide B from member
    expect((await overwrite(owner, b.id, member, 0n, P.VIEW_BOARDS)).status).toBe(200);
    expect((await t.http.get(`/api/boards/${b.id}`).set(member.auth)).status).toBe(404);
    expect((await t.http.get(`/api/spaces/${team.spaceId}/boards`).set(member.auth)).body.map((x: BoardDto) => x.id)).toEqual([a.id]);
    expect((await t.http.get(`/api/spaces/${team.spaceId}/boards`).set(owner.auth)).body).toHaveLength(2);
    // somebody without MANAGE_BOARDS may not change them
    expect((await overwrite(member, a.id, other, P.EDIT_TASKS, 0n)).status).toBe(403);
    // the permission map the web keeps
    const map = (await t.http.get('/api/board-permissions').set(member.auth)).body as { boards: Record<string, string>; spaces: Record<string, string> };
    expect(Object.keys(map.boards)).toEqual([a.id]);
    expect(BigInt(map.boards[a.id]!) & P.CREATE_TASKS).toBe(P.CREATE_TASKS);
    expect(Object.keys(map.spaces)).toContain(team.spaceId);
  });
});

// ------------------------------------------------------------------ 2. moving

describe('moving tasks', () => {
  it('updates the column and position, completes in a Done column, writes the activity and bumps the space seq', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const a = await newTask(owner, board.id, cols.todo.id, { title: 'A' });
    const before = await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } });

    const pos = nextPos();
    const moved = await moveTask(owner, a.id, cols.done.id, pos);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ columnId: cols.done.id, position: pos });
    expect(moved.body.completedAt).toBeTruthy();
    const after = await t.prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } });
    expect(after.changeSeq).toBeGreaterThan(before.changeSeq);
    expect(moved.body.seq).toBe(Number(after.changeSeq));

    const kinds = (await getTask(owner, a.id)).activity.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['created', 'moved', 'completed']));
    const entry = (await getTask(owner, a.id)).activity.find((x) => x.kind === 'moved')!;
    expect(entry.data).toMatchObject({ from: 'To do', to: 'Done' });

    // back out of Done: open again
    const back = await moveTask(owner, a.id, cols.doing.id);
    expect(back.body.completedAt).toBeNull();
    // a column of another board is not a place for it
    const other2 = await newBoard(owner, team.spaceId);
    expect((await moveTask(owner, a.id, (await columnsOf(owner, other2.id)).todo.id)).status).toBe(404);
  });

  it('refuses a move into a full column with 409 wip_limit (nothing changes); moving inside it, or out, is fine', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    await t.http.patch(`/api/columns/${cols.doing.id}`).set(owner.auth).send({ wipLimit: 2 });
    const [a, b, c] = [await newTask(owner, board.id, cols.todo.id), await newTask(owner, board.id, cols.todo.id), await newTask(owner, board.id, cols.todo.id)];
    expect((await moveTask(owner, a.id, cols.doing.id)).status).toBe(200);
    expect((await moveTask(owner, b.id, cols.doing.id)).status).toBe(200);
    const full = await moveTask(owner, c.id, cols.doing.id);
    expect(full.status).toBe(409);
    expect(full.body.message).toBe('wip_limit');
    expect((await rawTask(c.id)).columnId).toBe(cols.todo.id);
    expect((await taskRes(owner, board.id, cols.doing.id)).status).toBe(409); // a new task counts too
    expect((await moveTask(owner, a.id, cols.doing.id, nextPos())).status).toBe(200); // reordering inside is not a new arrival
    expect((await moveTask(owner, a.id, cols.todo.id)).status).toBe(200);
    expect((await moveTask(owner, c.id, cols.doing.id)).status).toBe(200); // there is room again
    // subtasks do not count against the limit
    const sub = await taskRes(owner, board.id, cols.doing.id, { parentTaskId: c.id });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
  });

  it('two people dropping at the same place and two racing for the last slot both end up consistent', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    await giveRole(team, member, P.EDIT_TASKS);
    const cols = await columnsOf(owner, board.id);
    const [a, b, c, d] = [0, 1, 2, 3].map(() => null) as unknown as TaskDto[];
    const tasks = [a, b, c, d];
    for (let i = 0; i < 4; i++) tasks[i] = await newTask(owner, board.id, cols.todo.id, { title: `T${i}` });

    // same key, same column, at the same moment
    const same = nextPos();
    const [r1, r2] = await Promise.all([moveTask(owner, tasks[0]!.id, cols.doing.id, same), moveTask(member, tasks[1]!.id, cols.doing.id, same)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const rows = await t.prisma.task.findMany({ where: { columnId: cols.doing.id } });
    expect(new Set(rows.map((r) => r.position)).size).toBe(2); // the later one was told apart
    const order1 = (await detail(owner, board.id)).tasks.filter((x) => x.columnId === cols.doing.id).map((x) => x.id);
    const order2 = (await detail(member, board.id)).tasks.filter((x) => x.columnId === cols.doing.id).map((x) => x.id);
    expect(order1).toEqual(order2);

    // a limit of 3 with 2 inside and two arrivals at once: exactly one gets in
    await t.http.patch(`/api/columns/${cols.doing.id}`).set(owner.auth).send({ wipLimit: 3 });
    const results = await Promise.all([moveTask(owner, tasks[2]!.id, cols.doing.id), moveTask(member, tasks[3]!.id, cols.doing.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.task.count({ where: { columnId: cols.doing.id, deletedAt: null } })).toBe(3);
  });

  it('re-keys a column when the keys have grown too long, keeping the order', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const first = await newTask(owner, board.id, cols.todo.id, { title: 'first', position: 'a0' });
    const last = await newTask(owner, board.id, cols.todo.id, { title: 'last', position: 'a1' });
    let upper = last.position;
    const made: string[] = [];
    for (let i = 0; i < 120; i++) {
      const res = await taskRes(owner, board.id, cols.todo.id, { title: `m${i}`, position: positionBetween(first.position, upper) });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      made.unshift(res.body.id);
      upper = (await rawTask(res.body.id)).position;
    }
    const tasks = (await detail(owner, board.id)).tasks.filter((x) => x.columnId === cols.todo.id);
    expect(tasks.map((x) => x.id)).toEqual([first.id, ...made, last.id]);
    expect(Math.max(...tasks.map((x) => x.position.length))).toBeLessThan(64);
  }, 60_000);

  it('moves a task to a board of another space (needs CREATE_TASKS there), taking its bytes with it and dropping what does not fit', async () => {
    const team = await newTeam();
    const project = await createProject(owner, team.id);
    const teamBoard = await newBoard(owner, team.spaceId, { name: 'Team' });
    const projectBoard = await newBoard(owner, project.spaceId, { name: 'Project' });
    const tc = await columnsOf(owner, teamBoard.id);
    const pc = await columnsOf(owner, projectBoard.id);
    // member is in the team but not in the project
    const task = await newTask(owner, teamBoard.id, tc.todo.id, { title: 'travels', assigneeIds: [member.id] });
    const before = await t.prisma.space.findMany({ where: { id: { in: [team.spaceId, project.spaceId] } } });
    const res = await moveTask(owner, task.id, pc.todo.id, nextPos(), { boardId: projectBoard.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ boardId: projectBoard.id, spaceId: project.spaceId, assigneeIds: [] }); // member cannot see the project
    expect(before.length).toBe(2);
    // the space it left tells its devices
    expect(await t.prisma.taskMove.count({ where: { spaceId: team.spaceId, taskId: task.id } })).toBe(1);
    const left = await changes(owner, { [team.spaceId]: 0 });
    expect(left.spaces[team.spaceId]!.movedOutTasks).toEqual([task.id]);
    // somebody without CREATE_TASKS on the target cannot send tasks there
    await giveRole(team, member, P.EDIT_TASKS);
    const mine = await newTask(owner, teamBoard.id, tc.todo.id);
    expect((await moveTask(member, mine.id, pc.todo.id, nextPos(), { boardId: projectBoard.id })).status).toBe(404); // cannot even see it
  });
});

// ------------------------------------------------------------------ 3. assignees and views

describe('assignees and "My tasks"', () => {
  it('assigning somebody who cannot see the board fails with a clear error; unassigning works', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id);
    const refused = await t.http.put(`/api/tasks/${task.id}/assignees/${outsider.id}`).set(owner.auth);
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe('assignee_cannot_view');
    // a member the board is hidden from (overwrite) cannot be assigned either
    await overwrite(owner, board.id, other, 0n, P.VIEW_BOARDS);
    expect((await t.http.put(`/api/tasks/${task.id}/assignees/${other.id}`).set(owner.auth)).status).toBe(422);
    expect((await taskRes(owner, board.id, cols.todo.id, { assigneeIds: [other.id] })).status).toBe(422);

    const ok = await t.http.put(`/api/tasks/${task.id}/assignees/${member.id}`).set(owner.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.assigneeIds).toEqual([member.id]);
    const gone = await t.http.delete(`/api/tasks/${task.id}/assignees/${member.id}`).set(owner.auth);
    expect(gone.body.assigneeIds).toEqual([]);
    expect((await getTask(owner, task.id)).activity.map((a) => a.kind)).toEqual(expect.arrayContaining(['assigned', 'unassigned']));
  });

  it('GET /api/me/tasks lists exactly the caller\'s tasks in spaces they can see, by due date, and follows what they may see now', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId, { name: 'Team board' });
    const cols = await columnsOf(owner, board.id);
    const later = await newTask(owner, board.id, cols.todo.id, { title: 'later', assigneeIds: [member.id], dueAt: '2026-05-02T00:00:00.000Z', allDay: true });
    const sooner = await newTask(owner, board.id, cols.todo.id, { title: 'sooner', assigneeIds: [member.id], dueAt: '2026-05-01T09:00:00.000Z' });
    const undated = await newTask(owner, board.id, cols.todo.id, { title: 'undated', assigneeIds: [member.id] });
    await newTask(owner, board.id, cols.todo.id, { title: 'not mine', assigneeIds: [other.id] });
    const finished = await newTask(owner, board.id, cols.todo.id, { title: 'finished', assigneeIds: [member.id] });
    await patchTask(owner, finished.id, { completed: true });
    // a personal board of the member's own
    const mine = await personalSpaceId(t, member.id);
    const pb = await newBoard(member, mine, { name: 'Mine' });
    const personal = await newTask(member, pb.id, (await columnsOf(member, pb.id)).todo.id, { title: 'personal', assigneeIds: [member.id], dueAt: '2026-04-30T00:00:00.000Z', allDay: true });
    // somebody else's personal board never shows up
    const ob = await newBoard(owner, await personalSpaceId(t, owner.id));
    await newTask(owner, ob.id, (await columnsOf(owner, ob.id)).todo.id, { title: 'secret', assigneeIds: [owner.id] });

    const res = await t.http.get('/api/me/tasks').set(member.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = res.body as { task: TaskDto; boardName: string }[];
    expect(list.map((x) => x.task.title)).toEqual(['personal', 'sooner', 'later', 'undated']);
    expect(list.map((x) => x.boardName)).toEqual(['Mine', 'Team board', 'Team board', 'Team board']);
    expect(list.map((x) => x.task.id)).toEqual([personal.id, sooner.id, later.id, undated.id]);
    // filters
    expect(((await t.http.get('/api/me/tasks').set(member.auth).query({ status: 'done' })).body as { task: TaskDto }[]).map((x) => x.task.title)).toEqual(['finished']);
    expect(((await t.http.get('/api/me/tasks').set(member.auth).query({ spaceId: team.spaceId })).body as unknown[]).length).toBe(3);
    expect(((await t.http.get('/api/me/tasks').set(member.auth).query({ due: 'none' })).body as { task: TaskDto }[]).map((x) => x.task.title)).toEqual(['undated']);
    expect(((await t.http.get('/api/me/tasks').set(owner.auth)).body as unknown[]).length).toBe(1); // only 'secret' is assigned to the owner

    // leave the team: its tasks go from the list at once
    await t.prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: member.id } });
    expect(((await t.http.get('/api/me/tasks').set(member.auth)).body as { task: TaskDto }[]).map((x) => x.task.title)).toEqual(['personal']);
    // the tasks of one space
    expect((await t.http.get(`/api/spaces/${team.spaceId}/tasks`).set(owner.auth)).body).toHaveLength(4);
    expect((await t.http.get(`/api/spaces/${team.spaceId}/tasks`).set(member.auth)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ 4. labels

describe('labels', () => {
  it('a team\'s inheritable labels are usable in its projects; a project\'s are not usable above, and a team label marked "not inheritable" stays home', async () => {
    const team = await newTeam([member]);
    const project = await createProject(owner, team.id);
    const sub = await createProject(owner, team.id, project.id);
    const mk = async (spaceId: string, name: string, extra: object = {}) =>
      (await t.http.post(`/api/spaces/${spaceId}/labels`).set(owner.auth).send({ id: uuid(), name, color: '#3366ff', ...extra })).body as { id: string };
    const teamLabel = await mk(team.spaceId, 'team-wide');
    const teamOnly = await mk(team.spaceId, 'team-only', { inheritable: false });
    const projLabel = await mk(project.spaceId, 'project');

    const teamBoard = await newBoard(owner, team.spaceId);
    const projBoard = await newBoard(owner, project.spaceId);
    const subBoard = await newBoard(owner, sub.spaceId);
    const tt = await newTask(owner, teamBoard.id, (await columnsOf(owner, teamBoard.id)).todo.id);
    const pt = await newTask(owner, projBoard.id, (await columnsOf(owner, projBoard.id)).todo.id);
    const st = await newTask(owner, subBoard.id, (await columnsOf(owner, subBoard.id)).todo.id);
    const names = async (spaceId: string) => ((await t.http.get(`/api/spaces/${spaceId}/labels`).set(owner.auth)).body as { name: string }[]).map((l) => l.name).sort();

    expect(await names(team.spaceId)).toEqual(['team-only', 'team-wide']);
    expect(await names(project.spaceId)).toEqual(['project', 'team-wide']);
    expect(await names(sub.spaceId)).toEqual(['project', 'team-wide']);
    expect((await detail(owner, projBoard.id)).labels.map((l) => l.name).sort()).toEqual(['project', 'team-wide']);

    expect((await patchTask(owner, pt.id, { labelIds: [teamLabel.id, projLabel.id] })).status).toBe(200);
    expect((await patchTask(owner, st.id, { labelIds: [teamLabel.id, projLabel.id] })).status).toBe(200); // a sub-project sees its parent's
    expect((await patchTask(owner, pt.id, { labelIds: [teamOnly.id] })).status).toBe(422); // not inheritable
    expect((await patchTask(owner, tt.id, { labelIds: [projLabel.id] })).status).toBe(422); // never the other way up
    expect((await t.http.put(`/api/tasks/${tt.id}/labels/${teamLabel.id}`).set(owner.auth)).body.labelIds).toEqual([teamLabel.id]);

    // making a label private takes it off the tasks of the projects below
    expect((await t.http.patch(`/api/labels/${teamLabel.id}`).set(owner.auth).send({ inheritable: false })).status).toBe(200);
    expect((await rawTask(pt.id).then(() => t.prisma.taskLabel.count({ where: { taskId: pt.id, labelId: teamLabel.id } })))).toBe(0);
    expect(await t.prisma.taskLabel.count({ where: { taskId: tt.id, labelId: teamLabel.id } })).toBe(1);
  });

  it('deleting a label takes it off every task and leaves tombstones that devices receive', async () => {
    const team = await newTeam();
    const project = await createProject(owner, team.id);
    const label = (await t.http.post(`/api/spaces/${team.spaceId}/labels`).set(owner.auth).send({ id: uuid(), name: 'bug', color: '#ff0000' })).body as { id: string };
    const board = await newBoard(owner, team.spaceId);
    const pBoard = await newBoard(owner, project.spaceId);
    const a = await newTask(owner, board.id, (await columnsOf(owner, board.id)).todo.id, { labelIds: [label.id] });
    const b = await newTask(owner, pBoard.id, (await columnsOf(owner, pBoard.id)).todo.id, { labelIds: [label.id] });
    const cursors = { [team.spaceId]: (await changes(owner, { [team.spaceId]: 0 })).spaces[team.spaceId]!.cursor, [project.spaceId]: (await changes(owner, { [project.spaceId]: 0 })).spaces[project.spaceId]!.cursor };

    expect((await t.http.delete(`/api/labels/${label.id}`).set(owner.auth)).status).toBe(204);
    expect(await t.prisma.taskLabel.count({ where: { labelId: label.id } })).toBe(0);
    const res = await changes(owner, cursors);
    const inTeam = res.spaces[team.spaceId]!;
    expect(inTeam.labels!.map((l) => [l.id, l.deletedAt !== null])).toEqual([[label.id, true]]);
    expect(inTeam.tasks!.map((x) => [x.id, x.labelIds])).toEqual([[a.id, []]]);
    expect(res.spaces[project.spaceId]!.tasks!.map((x) => [x.id, x.labelIds])).toEqual([[b.id, []]]); // the project below hears it too
    expect((await t.http.get(`/api/spaces/${team.spaceId}/labels`).set(owner.auth)).body).toEqual([]);
  });
});

// ------------------------------------------------------------------ 5. comments, files, quota

describe('comments, files and storage', () => {
  it('limits the comment size, lets only the author edit, lets the author or an editor delete, and counts the text against the space', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_TASKS);
    await giveRole(team, other, P.CREATE_TASKS);
    const board = await newBoard(owner, team.spaceId);
    const task = await newTask(owner, board.id, (await columnsOf(owner, board.id)).todo.id);
    const post = (who: Account, content: string, id = uuid()) => t.http.post(`/api/tasks/${task.id}/comments`).set(who.auth).send({ id, content });

    expect((await post(member, 'x'.repeat(BOARD_LIMITS.commentMax + 1))).status).toBe(400);
    expect((await post(member, '   ')).status).toBe(400);
    const used0 = await t.app.get((await import('../src/quota/quota.service.js')).QuotaService).usage('team', team.id);
    const id = uuid();
    const c = await post(member, 'hello there', id);
    expect(c.status).toBe(201);
    expect((await post(member, 'hello there', id)).body.id).toBe(id); // a resend is the same comment
    expect(await t.prisma.taskComment.count({ where: { taskId: task.id } })).toBe(1);
    const used1 = await t.app.get((await import('../src/quota/quota.service.js')).QuotaService).usage('team', team.id);
    expect(used1 - used0).toBe(Buffer.byteLength('hello there'));

    expect((await t.http.patch(`/api/comments/${id}`).set(other.auth).send({ content: 'mine' })).status).toBe(403);
    expect((await t.http.patch(`/api/comments/${id}`).set(owner.auth).send({ content: 'mine' })).status).toBe(403); // even the owner: authors only
    const edited = await t.http.patch(`/api/comments/${id}`).set(member.auth).send({ content: 'hello again' });
    expect(edited.status).toBe(200);
    expect(edited.body.editedAt).toBeTruthy();
    expect((await t.http.delete(`/api/comments/${id}`).set(other.auth)).status).toBe(403);
    expect((await t.http.delete(`/api/comments/${id}`).set(member.auth)).status).toBe(204);
    expect(await t.app.get((await import('../src/quota/quota.service.js')).QuotaService).usage('team', team.id)).toBe(used0);
    expect((await getTask(owner, task.id)).task.commentCount).toBe(0);
  });

  it('refuses a file that does not fit with 413 and the scope, counts it, and gives the bytes back when the task is deleted for good', async () => {
    const space = await personalSpaceId(t, owner.id);
    const board = await newBoard(owner, space);
    const todo = (await columnsOf(owner, board.id)).todo.id;
    const base = await usedBytes(t, owner.id);
    const task = await newTask(owner, board.id, todo, { title: '' + 'T' });
    const file = await png(60, 40);
    const upload = (id = uuid(), buf = file) => t.http.post(`/api/tasks/${task.id}/attachments`).set(owner.auth).field('id', id).attach('file', buf, 'photo.png');

    const withTask = await usedBytes(t, owner.id);
    expect(withTask).toBe(base + 1);
    await t.prisma.quotaOverride.create({ data: { id: uuid(), scope: 'user', scopeId: owner.id, storageBytes: BigInt(withTask + file.length - 1), updatedBy: owner.id } });
    const refused = await upload();
    expect(refused.status, JSON.stringify(refused.body)).toBe(413);
    expect(refused.body).toMatchObject({ code: 'quota_exceeded', scope: 'user' });
    expect(await t.prisma.taskAttachment.count({ where: { taskId: task.id } })).toBe(0);

    await t.prisma.quotaOverride.deleteMany();
    const id = uuid();
    const ok = await upload(id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ id, taskId: task.id, mime: 'image/png', kind: 'image', name: 'photo.png' });
    expect((await upload(id)).body.id).toBe(id); // a retry is the same file
    expect(await usedBytes(t, owner.id)).toBe(withTask + file.length);
    const detailed = await getTask(owner, task.id);
    expect(detailed.attachments).toHaveLength(1);
    expect(detailed.task.attachmentCount).toBe(1);
    const stored = (await t.prisma.media.findUniqueOrThrow({ where: { id } }));
    expect(existsSync(t.app.get(StorageService).mediaPath(stored.userId, stored.id))).toBe(true);
    // the file is served to who can see the board, and only to them
    const asOwner = await t.http.get(`/api/media/${id}`).set(owner.auth);
    expect(asOwner.status).toBe(200);
    expect((await t.http.get(`/api/media/${id}`).set(outsider.auth)).status).toBe(404);

    // a deleted task keeps its bytes (archive does not refund); deleting it for good gives them back
    expect((await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth)).status).toBe(204);
    expect(await usedBytes(t, owner.id)).toBe(withTask + file.length);
    expect((await t.http.delete(`/api/tasks/${task.id}/purge`).set(owner.auth)).status).toBe(204);
    expect(await usedBytes(t, owner.id)).toBe(base);
    expect(await t.prisma.media.count({ where: { id } })).toBe(0);
    expect(existsSync(t.app.get(StorageService).mediaPath(stored.userId, stored.id))).toBe(false);
  });

  it('removes a file on request and gives its bytes back; only the uploader or an editor may', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_TASKS);
    const board = await newBoard(owner, team.spaceId);
    const task = await newTask(owner, board.id, (await columnsOf(owner, board.id)).todo.id, { assigneeIds: [member.id] });
    const id = uuid();
    const base = await t.app.get((await import('../src/quota/quota.service.js')).QuotaService).usage('team', team.id);
    expect((await t.http.post(`/api/tasks/${task.id}/attachments`).set(member.auth).field('id', id).attach('file', await png(), 'a.png')).status).toBe(201);
    expect((await t.http.delete(`/api/tasks/${task.id}/attachments/${id}`).set(other.auth)).status).toBe(403);
    expect((await t.http.delete(`/api/tasks/${task.id}/attachments/${id}`).set(member.auth)).status).toBe(204);
    expect(await t.app.get((await import('../src/quota/quota.service.js')).QuotaService).usage('team', team.id)).toBe(base);
    expect((await getTask(owner, task.id)).task.attachmentCount).toBe(0);
  });

  it('counts the text of tasks against the space and gives it back when they are deleted for good', async () => {
    const space = await personalSpaceId(t, owner.id);
    const board = await newBoard(owner, space);
    const todo = (await columnsOf(owner, board.id)).todo.id;
    const base = await usedBytes(t, owner.id);
    const task = await newTask(owner, board.id, todo, { title: 'abc', description: taskDocFromText('some words') });
    const grown = await usedBytes(t, owner.id);
    expect(grown).toBeGreaterThan(base + 3);
    await patchTask(owner, task.id, { title: 'abcdefgh' });
    expect(await usedBytes(t, owner.id)).toBe(grown + 5);
    await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth);
    expect(await usedBytes(t, owner.id)).toBe(grown + 5);
    expect((await t.http.delete(`/api/tasks/${task.id}/purge`).set(owner.auth)).status).toBe(204);
    expect(await usedBytes(t, owner.id)).toBe(base);
    // a task that does not fit is refused as a whole
    await t.prisma.quotaOverride.create({ data: { id: uuid(), scope: 'user', scopeId: owner.id, storageBytes: BigInt(base + 4), updatedBy: owner.id } });
    const big = await taskRes(owner, board.id, todo, { title: 'much too long for four bytes' });
    expect(big.status).toBe(413);
    expect(await t.prisma.task.count({ where: { boardId: board.id } })).toBe(0);
  });
});

// ------------------------------------------------------------------ the task itself

describe('the task', () => {
  it('keeps a validated description, dates, priority, checklist, subtasks and an activity entry for each step', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id, { title: 'Plan the launch' });

    // description: the reduced document only
    const image = { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId: uuid() } }] };
    const bad = await patchTask(owner, task.id, { description: image });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toContain('invalid_description');
    const evil = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] };
    expect((await patchTask(owner, task.id, { description: evil })).status).toBe(422);
    expect((await patchTask(owner, task.id, { description: taskDocFromText('First line\nSecond line') })).status).toBe(200);

    // dates: an all-day task keeps its calendar day, and the end cannot come before the start
    const dates = await patchTask(owner, task.id, { allDay: true, startAt: '2026-06-01T15:30:00.000Z', dueAt: '2026-06-03T23:59:00.000Z', priority: 'high' });
    expect(dates.status, JSON.stringify(dates.body)).toBe(200);
    expect(dates.body).toMatchObject({ allDay: true, startAt: '2026-06-01T00:00:00.000Z', dueAt: '2026-06-03T00:00:00.000Z', priority: 'high' });
    expect((await patchTask(owner, task.id, { dueAt: '2026-05-01T00:00:00.000Z' })).status).toBe(422);

    // checklist (the whole list, then one item at a time)
    const item = uuid();
    expect((await patchTask(owner, task.id, { checklist: [{ id: item, text: 'draft', done: false, position: 'a0' }] })).body.checklist).toHaveLength(1);
    const added = await t.http.post(`/api/tasks/${task.id}/checklist`).set(owner.auth).send({ id: uuid(), text: 'review', position: 'a1' });
    expect(added.body.checklist.map((c: { text: string }) => c.text)).toEqual(['draft', 'review']);
    expect((await t.http.patch(`/api/tasks/${task.id}/checklist/${item}`).set(owner.auth).send({ done: true })).body.checklist[0].done).toBe(true);
    expect((await t.http.delete(`/api/tasks/${task.id}/checklist/${item}`).set(owner.auth)).body.checklist.map((c: { text: string }) => c.text)).toEqual(['review']);

    // subtasks: one level, with their own done state, and listed with the parent
    const sub = await newTask(owner, board.id, cols.todo.id, { title: 'Book the venue', parentTaskId: task.id });
    expect((await taskRes(owner, board.id, cols.todo.id, { parentTaskId: sub.id })).status).toBe(422); // no subtasks of subtasks
    expect((await patchTask(owner, sub.id, { completed: true })).body.columnId).toBe(cols.todo.id); // a subtask is done without moving
    const withSubs = await getTask(owner, task.id);
    expect(withSubs.subtasks.map((s) => [s.title, !!s.completedAt])).toEqual([['Book the venue', true]]);
    expect((await moveTask(owner, sub.id, cols.doing.id)).status).toBe(422);
    expect((await moveTask(owner, task.id, cols.doing.id)).status).toBe(200);
    expect((await rawTask(sub.id)).columnId).toBe(cols.doing.id); // they travel with the parent

    expect(withSubs.activity.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['created', 'described', 'dates', 'priority', 'checklist_added', 'checklist_done', 'checklist_removed', 'subtask_added']),
    );
    // an update that changes nothing writes nothing
    const seq = (await rawTask(task.id)).seq;
    expect((await patchTask(owner, task.id, { title: 'Plan the launch', priority: 'high' })).status).toBe(200);
    expect((await rawTask(task.id)).seq).toBe(seq);
    // the history pages
    const page = await t.http.get(`/api/tasks/${task.id}/activity`).set(owner.auth).query({ limit: 3 });
    expect(page.body.items).toHaveLength(3);
    expect(page.body.nextCursor).toBeTruthy();
    const more = await t.http.get(`/api/tasks/${task.id}/activity`).set(owner.auth).query({ limit: 50, before: page.body.nextCursor });
    expect(more.body.items.length).toBeGreaterThan(0);
    expect(more.body.items[0].id).not.toBe(page.body.items[0].id);
  });

  it('goes to the trash with its subtasks, can be restored, and is deleted for good only from the trash', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const task = await newTask(owner, board.id, cols.todo.id);
    const sub = await newTask(owner, board.id, cols.todo.id, { parentTaskId: task.id });
    expect((await t.http.delete(`/api/tasks/${task.id}/purge`).set(owner.auth)).status).toBe(422); // not in the trash yet
    expect((await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth)).status).toBe(204);
    expect((await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth)).status).toBe(204); // twice is fine
    expect((await t.http.get(`/api/tasks/${task.id}`).set(owner.auth)).status).toBe(404);
    expect((await rawTask(sub.id)).deletedAt).not.toBeNull();
    expect(((await t.http.get(`/api/boards/${board.id}/trash`).set(owner.auth)).body as TaskDto[]).map((x) => x.id)).toEqual([task.id]);
    expect((await detail(owner, board.id)).tasks).toEqual([]);
    expect((await t.http.post(`/api/tasks/${task.id}/restore`).set(owner.auth)).status).toBe(200);
    expect((await detail(owner, board.id)).tasks.map((x) => x.id).sort()).toEqual([task.id, sub.id].sort());
    // a column that has gone: the task comes back in the first one
    await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth);
    await t.http.delete(`/api/columns/${cols.todo.id}`).set(owner.auth).send({ moveTo: cols.doing.id });
    expect((await t.http.post(`/api/tasks/${task.id}/restore`).set(owner.auth)).body.columnId).toBe(cols.doing.id);
    // for good
    await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth);
    expect((await t.http.delete(`/api/tasks/${task.id}/purge`).set(owner.auth)).status).toBe(204);
    expect(await t.prisma.task.count({ where: { id: { in: [task.id, sub.id] } } })).toBe(0);
    // the nightly job removes what has been in the trash too long
    const old = await newTask(owner, board.id, cols.doing.id);
    await t.http.delete(`/api/tasks/${old.id}`).set(owner.auth);
    await t.prisma.task.update({ where: { id: old.id }, data: { deletedAt: new Date(Date.now() - 40 * 86_400_000) } });
    expect(await t.app.get(BoardsMaintenance).purgeTrash()).toBe(1);
    expect(await t.prisma.task.count({ where: { id: old.id } })).toBe(0);
  });
});

// ------------------------------------------------------------------ notifications

describe('notifications', () => {
  it('tells the person who got a task, who was mentioned in a comment and who works on a task that was commented on; not the author', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_TASKS);
    await giveRole(team, other, P.CREATE_TASKS);
    const board = await newBoard(owner, team.spaceId);
    const task = await newTask(owner, board.id, (await columnsOf(owner, board.id)).todo.id, { title: 'Ship it' });
    const inbox = async (who: Account) => (await t.prisma.notification.findMany({ where: { userId: who.id }, orderBy: { createdAt: 'asc' } })).map((n) => [n.kind, n.targetKind, n.targetId]);

    await t.http.put(`/api/tasks/${task.id}/assignees/${member.id}`).set(owner.auth);
    expect(await inbox(member)).toEqual([['task_assigned', 'task', task.id]]);
    expect(await inbox(owner)).toEqual([]); // assigning is not something to be told about yourself

    // a comment from `other`, mentioning the owner (and a person outside the team, who is ignored)
    const res = await t.http.post(`/api/tasks/${task.id}/comments`).set(other.auth).send({ id: uuid(), content: `looks good <@user:${owner.id}> and <@user:${outsider.id}>` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.mentions.users).toEqual([owner.id]);
    expect(await inbox(owner)).toEqual([['mention_user', 'task', task.id]]);
    expect(await inbox(member)).toEqual([['task_assigned', 'task', task.id], ['task_comment', 'task', task.id]]); // the assignee hears of the comment
    expect(await inbox(other)).toEqual([]);
    expect(await inbox(outsider)).toEqual([]);

    // somebody who muted the team hears nothing
    await t.http.put('/api/notification-settings').set(member.auth).send({ scopeKind: 'team', scopeId: team.id, mutedUntil: '2999-01-01T00:00:00.000Z' });
    await t.http.put(`/api/tasks/${task.id}/assignees/${other.id}`).set(owner.auth);
    await t.http.post(`/api/tasks/${task.id}/comments`).set(owner.auth).send({ id: uuid(), content: 'ping' }).catch(() => undefined);
    expect((await inbox(member)).length).toBe(2);
  });

  it('tells the people of a task that is due soon once, and only those who can still see the board', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const todo = (await columnsOf(owner, board.id)).todo.id;
    const soon = await newTask(owner, board.id, todo, { title: 'soon', assigneeIds: [member.id, other.id], dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
    await newTask(owner, board.id, todo, { title: 'far', assigneeIds: [member.id], dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    await newTask(owner, board.id, todo, { title: 'done', assigneeIds: [member.id], dueAt: new Date(Date.now() + 3_600_000).toISOString(), completed: true });
    await overwrite(owner, board.id, other, 0n, P.VIEW_BOARDS); // other may no longer see it

    const sweep = t.app.get(BoardsMaintenance);
    expect(await sweep.notifyDue()).toBe(1);
    expect(await sweep.notifyDue()).toBe(0); // once per due date
    expect((await t.prisma.notification.findMany({ where: { kind: 'task_due' } })).map((n) => [n.userId, n.targetId])).toEqual([[member.id, soon.id]]);
    // a new due date is a new notice
    await patchTask(owner, soon.id, { dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString() });
    expect(await sweep.notifyDue()).toBe(1);
  });
});

// ------------------------------------------------------------------ 6. sync

describe('sync', () => {
  it('delivers boards, columns, tasks and labels with tombstones, per space, and hides them again when access ends', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    const first = await changes(member, { [team.spaceId]: 0 });
    const space = first.spaces[team.spaceId]!;
    expect(space.boards!.map((b) => b.id)).toEqual([board.id]);
    expect(space.columns).toHaveLength(3);
    let cursor = space.cursor;

    const task = await newTask(owner, board.id, cols.todo.id, { title: 'Sync me', assigneeIds: [member.id] });
    let res = (await changes(member, { [team.spaceId]: cursor })).spaces[team.spaceId]!;
    expect(res.tasks!.map((x) => [x.id, x.title, x.assigneeIds, x.deletedAt])).toEqual([[task.id, 'Sync me', [member.id], null]]);
    cursor = res.cursor;

    await patchTask(owner, task.id, { title: 'Renamed' });
    res = (await changes(member, { [team.spaceId]: cursor })).spaces[team.spaceId]!;
    expect(res.tasks!.map((x) => x.title)).toEqual(['Renamed']);
    cursor = res.cursor;

    await moveTask(owner, task.id, cols.done.id);
    res = (await changes(member, { [team.spaceId]: cursor })).spaces[team.spaceId]!;
    expect(res.tasks!.map((x) => [x.columnId, !!x.completedAt])).toEqual([[cols.done.id, true]]);
    cursor = res.cursor;

    await t.http.delete(`/api/tasks/${task.id}`).set(owner.auth);
    res = (await changes(member, { [team.spaceId]: cursor })).spaces[team.spaceId]!;
    expect(res.tasks!.map((x) => [x.id, x.deletedAt !== null])).toEqual([[task.id, true]]);
    cursor = res.cursor;

    // a board hidden by an overwrite is listed as hidden (its rows are not sent) ...
    await overwrite(owner, board.id, member, 0n, P.VIEW_BOARDS);
    res = (await changes(member, { [team.spaceId]: 0 })).spaces[team.spaceId]!;
    expect(res.hiddenBoards).toEqual([board.id]);
    expect(res.boards).toEqual([]);
    expect(res.tasks).toEqual([]);
    // ... and a person who leaves the team has the whole space revoked
    await t.prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: member.id } });
    const gone = await changes(member, { [team.spaceId]: cursor });
    expect(gone.revokedSpaces).toEqual([team.spaceId]);
    expect(gone.spaces[team.spaceId]).toBeUndefined();
  });

  it('applies the offline task operations in order, each one standing alone, and reports a full column as wip_limit', async () => {
    const team = await newTeam();
    await giveRole(team, member, P.CREATE_TASKS | P.EDIT_TASKS);
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    await t.http.patch(`/api/columns/${cols.doing.id}`).set(owner.auth).send({ wipLimit: 1 });
    const a = uuid();
    const b = uuid();
    const ops = [
      { opId: uuid(), type: 'task.create', boardId: board.id, id: a, columnId: cols.todo.id, position: 'a0', title: 'Offline A' },
      { opId: uuid(), type: 'task.create', boardId: board.id, id: b, columnId: cols.todo.id, position: 'a1', title: 'Offline B', priority: 'low' },
      { opId: uuid(), type: 'task.update', id: a, title: 'Offline A (edited)' },
      { opId: uuid(), type: 'task.move', id: a, columnId: cols.doing.id, position: 'a0' },
      { opId: uuid(), type: 'task.move', id: b, columnId: cols.doing.id, position: 'a1' },
      { opId: uuid(), type: 'task.delete', id: uuid() },
      { opId: uuid(), type: 'task.update', id: a, priority: 'nonsense' },
    ];
    const res = await t.http.post('/api/sync/batch').set(member.auth).send({ ops });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { ok: boolean; error?: string }) => (r.ok ? 'ok' : r.error))).toEqual(['ok', 'ok', 'ok', 'ok', 'wip_limit', 'ok', 'invalid']);
    expect((await rawTask(a)).columnId).toBe(cols.doing.id);
    expect((await rawTask(a)).title).toBe('Offline A (edited)');
    expect((await rawTask(b)).columnId).toBe(cols.todo.id);
    // a replay of the whole batch changes nothing
    const again = await t.http.post('/api/sync/batch').set(member.auth).send({ ops: ops.slice(0, 4) });
    expect(again.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(await t.prisma.task.count({ where: { boardId: board.id } })).toBe(2);
  });
});

// ------------------------------------------------------------------ realtime

describe('realtime', () => {
  it('sends task events to the room of the board (the row) and to the room of the space (only that something changed)', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const cols = await columnsOf(owner, board.id);
    await overwrite(owner, board.id, other, 0n, P.VIEW_BOARDS); // other sees the space but not this board

    const m = await connect(url, member);
    const o = await connect(url, other);
    const out = await connect(url, outsider);
    expect(await ack(m, 'room:join', { kind: 'board', id: board.id })).toMatchObject({ ok: true });
    expect(await ack(o, 'room:join', { kind: 'board', id: board.id })).toMatchObject({ ok: false });
    expect(await ack(o, 'room:join', { kind: 'space', id: team.spaceId })).toMatchObject({ ok: true });
    expect(await ack(out, 'room:join', { kind: 'board', id: board.id })).toMatchObject({ ok: false });

    const created = collect<TaskDto>(m, BOARD_EVENTS.taskCreated);
    const moved = collect<TaskDto>(m, BOARD_EVENTS.taskMoved);
    const updated = collect<TaskDto>(m, BOARD_EVENTS.taskUpdated);
    const heardByOther = collect<Record<string, unknown>>(o, BOARD_EVENTS.taskCreated);
    const task = await newTask(owner, board.id, cols.todo.id, { title: 'Live' });
    await moveTask(owner, task.id, cols.doing.id);
    await patchTask(owner, task.id, { priority: 'urgent' });
    await sleep(300);
    expect(created.map((x) => x.title)).toEqual(['Live']); // from the board room (the space room's copy has no title)
    expect(moved.map((x) => x.columnId)).toEqual([cols.doing.id]);
    expect(updated.map((x) => x.priority)).toContain('urgent');
    // the person who may not see the board hears that something changed, and nothing about what
    expect(heardByOther).toHaveLength(1);
    expect(heardByOther[0]).toEqual({ spaceId: team.spaceId, boardId: board.id, id: task.id });
  });

  it('takes a person out of the room of a board when an overwrite hides it', async () => {
    const team = await newTeam();
    const board = await newBoard(owner, team.spaceId);
    const m = await connect(url, member);
    expect(await ack(m, 'room:join', { kind: 'board', id: board.id })).toMatchObject({ ok: true });
    const heard = collect(m, BOARD_EVENTS.taskCreated);
    await overwrite(owner, board.id, member, 0n, P.VIEW_BOARDS);
    await newTask(owner, board.id, (await columnsOf(owner, board.id)).todo.id);
    await sleep(300);
    expect(heard).toHaveLength(0);
  });
});
