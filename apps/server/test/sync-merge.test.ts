import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseOf, mergeUpdate, nextFieldSeq, positionBetween, type BoardDetailDto, type EventDto, type FieldSeq, type SyncOpResult, type TaskDto } from '@os-planner/shared';
import { createTestApp, type TestApp } from './app.js';
import { builders, personalSpaceId, signup, usedBytes, uuid, type Account } from './helpers.js';

let t: TestApp;
let me: Account;
let space: string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  me = await signup(t);
  space = await personalSpaceId(t, me.id);
});

// ------------------------------------------------------------------ helpers

const batch = async (ops: object[], who: Account = me): Promise<SyncOpResult[]> => {
  const res = await t.http.post('/api/sync/batch').set(who.auth).send({ ops });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.results as SyncOpResult[];
};

let pos: string | null = null;
const nextPos = (): string => (pos = positionBetween(pos, null));

async function newTask(body: object = {}): Promise<{ task: TaskDto; columns: BoardDetailDto['columns'] }> {
  const board = await t.http.post(`/api/spaces/${space}/boards`).set(me.auth).send({ id: uuid(), name: 'Board', position: nextPos() });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  const detail = (await t.http.get(`/api/boards/${board.body.id}`).set(me.auth)).body as BoardDetailDto;
  const column = detail.columns[0]!;
  const res = await t.http.post(`/api/boards/${board.body.id}/tasks`).set(me.auth).send({ id: uuid(), columnId: column.id, position: nextPos(), title: 'Task', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { task: res.body as TaskDto, columns: detail.columns };
}
const getTask = async (id: string): Promise<TaskDto> => {
  const res = await t.http.get(`/api/tasks/${id}`).set(me.auth);
  expect(res.status).toBe(200);
  return res.body.task as TaskDto;
};
const patchTask = (id: string, body: object) => t.http.patch(`/api/tasks/${id}`).set(me.auth).send(body);
const taskBase = (task: TaskDto, keys: string[]) => baseOf('task', task.fieldSeq, keys);
const usedBytesOf = (userId: string) => usedBytes(t, userId);
const spaceSeq = async (): Promise<bigint> => (await t.prisma.space.findUniqueOrThrow({ where: { id: space } })).changeSeq;

// ------------------------------------------------------------------ tasks

describe('task.update with a base', () => {
  it('applies a field nobody else changed and reports it', async () => {
    const { task } = await newTask();
    const [r] = await batch([{ opId: uuid(), type: 'task.update', id: task.id, priority: 'high', base: taskBase(task, ['priority']) }]);
    expect(r).toMatchObject({ ok: true, status: 'applied', applied: ['priority'] });
    expect((await getTask(task.id)).priority).toBe('high');
  });

  it('merges two devices: disjoint fields both stay, the loser of a shared field gets the online value back', async () => {
    const { task } = await newTask();
    // both devices saw the same task
    const a = [{ opId: uuid(), type: 'task.update', id: task.id, title: 'A title', dueAt: '2027-05-01T10:00:00.000Z', base: taskBase(task, ['title', 'dueAt']) }];
    const b = [{ opId: uuid(), type: 'task.update', id: task.id, title: 'B title', priority: 'high', base: taskBase(task, ['title', 'priority']) }];
    expect((await batch(a))[0]).toMatchObject({ ok: true, status: 'applied' });
    const [rb] = await batch(b);
    expect(rb).toMatchObject({ ok: true, status: 'merged', applied: ['priority'] });
    if (!rb!.ok || !rb!.rejected) throw new Error('expected a rejected title');
    expect(rb!.rejected['title']).toMatchObject({ mine: 'B title', server: 'A title' });
    const now = await getTask(task.id);
    expect(now).toMatchObject({ title: 'A title', priority: 'high' });
    expect(now.dueAt).toBe('2027-05-01T10:00:00.000Z');
    expect(rb!.entity?.kind).toBe('task');
  });

  it('refuses a change of which nothing may be applied, and changes nothing at all', async () => {
    const { task } = await newTask();
    expect((await patchTask(task.id, { title: 'online' })).status).toBe(200);
    const before = { row: await t.prisma.task.findUniqueOrThrow({ where: { id: task.id } }), seq: await spaceSeq() };
    const [r] = await batch([{ opId: uuid(), type: 'task.update', id: task.id, title: 'mine', base: taskBase(task, ['title']) }]);
    expect(r).toMatchObject({ ok: false, status: 'rejected', error: 'conflict' });
    if (r!.ok || !r!.rejected) throw new Error('expected rejected');
    expect(r!.rejected['title']).toMatchObject({ mine: 'mine', server: 'online' });
    expect(await t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before.row);
    expect(await spaceSeq()).toBe(before.seq); // not even the counter moved
  });

  it('answers a partial success in one batch: the rejected op does not stop the others', async () => {
    const one = (await newTask({ title: 'one' })).task;
    const two = (await newTask({ title: 'two' })).task;
    await patchTask(one.id, { title: 'online' });
    const results = await batch([
      { opId: uuid(), type: 'task.update', id: one.id, title: 'mine', base: taskBase(one, ['title']) },
      { opId: uuid(), type: 'task.update', id: two.id, title: 'edited', base: taskBase(two, ['title']) },
    ]);
    expect(results.map((r) => (r.ok ? r.status : r.error))).toEqual(['conflict', 'applied']);
    expect((await getTask(two.id)).title).toBe('edited');
    expect((await getTask(one.id)).title).toBe('online');
  });

  it("a device does not conflict with its own earlier ops of the same push", async () => {
    const { task } = await newTask();
    const base = taskBase(task, ['title']);
    const results = await batch([
      { opId: uuid(), type: 'task.update', id: task.id, title: 'first', base },
      { opId: uuid(), type: 'task.update', id: task.id, title: 'second', base },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await getTask(task.id)).title).toBe('second');
  });

  it('applies everything when the device sent no base (a client from before)', async () => {
    const { task } = await newTask();
    await patchTask(task.id, { title: 'online' });
    const [r] = await batch([{ opId: uuid(), type: 'task.update', id: task.id, title: 'later wins' }]);
    expect(r).toMatchObject({ ok: true });
    expect((await getTask(task.id)).title).toBe('later wins');
  });

  it('a replay of an applied op is not a conflict', async () => {
    const { task } = await newTask();
    const op = { opId: uuid(), type: 'task.update', id: task.id, title: 'once', base: taskBase(task, ['title']) };
    expect((await batch([op]))[0]).toMatchObject({ ok: true });
    expect((await batch([op]))[0]).toMatchObject({ ok: true });
  });

  it('an edit of a task deleted online is refused and the task stays deleted', async () => {
    const { task } = await newTask();
    await t.http.delete(`/api/tasks/${task.id}`).set(me.auth);
    const [r] = await batch([{ opId: uuid(), type: 'task.update', id: task.id, title: 'mine', base: taskBase(task, ['title']) }]);
    expect(r).toMatchObject({ ok: false, error: 'target_deleted' });
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).deletedAt).not.toBeNull();
  });

  it('a delete of a task that changed online meanwhile is refused; a delete of an unchanged one goes through', async () => {
    const changed = (await newTask()).task;
    const same = (await newTask()).task;
    await patchTask(changed.id, { priority: 'urgent' });
    const results = await batch([
      { opId: uuid(), type: 'task.delete', id: changed.id, base: taskBase(changed, []) },
      { opId: uuid(), type: 'task.delete', id: same.id, base: taskBase(same, []) },
    ]);
    expect(results[0]).toMatchObject({ ok: false, error: 'deleted_but_changed' });
    expect(results[1]).toMatchObject({ ok: true });
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: changed.id } })).deletedAt).toBeNull();
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: same.id } })).deletedAt).not.toBeNull();
    // deleting what is deleted already is fine
    expect((await batch([{ opId: uuid(), type: 'task.delete', id: same.id, base: taskBase(same, []) }]))[0]).toMatchObject({ ok: true });
  });
});

describe('task.move with a base', () => {
  it('keeps the online place when somebody else moved the task meanwhile', async () => {
    const { task, columns } = await newTask();
    const [todo, doing, done] = columns as [(typeof columns)[number], (typeof columns)[number], (typeof columns)[number]];
    const moveOnline = await t.http.post(`/api/tasks/${task.id}/move`).set(me.auth).send({ columnId: doing.id, position: nextPos() });
    expect(moveOnline.status).toBe(200);
    const [r] = await batch([{ opId: uuid(), type: 'task.move', id: task.id, columnId: done.id, position: nextPos(), base: baseOf('task', task.fieldSeq, ['columnId', 'position'], 'move') }]);
    expect(r).toMatchObject({ ok: false, error: 'conflict' });
    expect((await getTask(task.id)).columnId).toBe(doing.id);
    // from the column the device saw, in a task that was not moved: applied
    const made = await t.http.post(`/api/boards/${task.boardId}/tasks`).set(me.auth).send({ id: uuid(), columnId: todo.id, position: nextPos(), title: 'Fresh' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const fresh = made.body as TaskDto;
    const [ok] = await batch([{ opId: uuid(), type: 'task.move', id: fresh.id, columnId: done.id, position: nextPos(), base: baseOf('task', fresh.fieldSeq, ['columnId', 'position'], 'move') }]);
    expect(ok).toMatchObject({ ok: true, status: 'applied' });
  });
});

describe('two devices (property)', () => {
  it('leaves one winner per conflicting field and keeps every field only one side changed, whatever the order of the pushes', async () => {
    const FIELDS = ['title', 'priority', 'dueAt'] as const;
    const value = (who: string, f: string) => (f === 'dueAt' ? (who === 'a' ? '2027-06-01T08:00:00.000Z' : '2027-07-01T08:00:00.000Z') : f === 'priority' ? (who === 'a' ? 'low' : 'high') : `${who}-title`);
    let state = 99;
    const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 12; round++) {
      const { task } = await newTask({ title: 'start' });
      const pick = () => FIELDS.filter(() => rand() < 0.6);
      const sets = { a: pick(), b: pick() };
      const order = rand() < 0.5 ? (['a', 'b'] as const) : (['b', 'a'] as const);
      // the reference: the same merge on the field versions
      let fieldSeq: FieldSeq = {};
      const expected: Record<string, unknown> = { title: 'start', priority: 'none', dueAt: null };
      let n = 0;
      for (const who of order) {
        const changes = Object.fromEntries(sets[who].map((f) => [f, value(who, f)]));
        const ref = mergeUpdate({ fieldSeq, deleted: false, base: Object.fromEntries(sets[who].map((f) => [f === 'dueAt' ? 'dates' : f, 0])), changes: Object.fromEntries(sets[who].map((f) => [f === 'dueAt' ? 'dates' : f, value(who, f)])), server: {} });
        if (ref.outcome === 'target_deleted') throw new Error('unexpected');
        n++;
        for (const f of ref.apply) {
          expected[f === 'dates' ? 'dueAt' : f] = value(who, f === 'dates' ? 'dueAt' : f);
        }
        fieldSeq = nextFieldSeq(fieldSeq, ref.apply, n);
        void changes;
      }
      for (const who of order) {
        if (!sets[who].length) continue;
        const body = Object.fromEntries(sets[who].map((f) => [f, value(who, f)]));
        await batch([{ opId: uuid(), type: 'task.update', id: task.id, ...body, base: taskBase(task, sets[who]) }]);
      }
      const now = await getTask(task.id);
      expect({ title: now.title, priority: now.priority, dueAt: now.dueAt }, `round ${round}: ${JSON.stringify({ sets, order })}`).toEqual(expected);
    }
  });
});

// ------------------------------------------------------------------ notebooks, categories, pages

describe('notebook tree with a base', () => {
  it('merges a rename and a colour change from two devices; the same field keeps the online value', async () => {
    const b = builders(t, me);
    const nb = await b.notebook('Old');
    const dto = (await t.http.get(`/api/notebooks/${nb.id}/tree`).set(me.auth)).body.notebook as { fieldSeq?: FieldSeq };
    const base = (keys: string[]) => baseOf('notebook', dto.fieldSeq, keys);
    expect((await batch([{ opId: uuid(), type: 'notebook.update', id: nb.id, name: 'Online', base: base(['name']) }]))[0]).toMatchObject({ ok: true });
    const [r] = await batch([{ opId: uuid(), type: 'notebook.update', id: nb.id, name: 'Mine', color: '#112233', base: base(['name', 'color']) }]);
    expect(r).toMatchObject({ ok: true, status: 'merged', applied: ['color'] });
    const row = await t.prisma.notebook.findUniqueOrThrow({ where: { id: nb.id } });
    expect(row).toMatchObject({ name: 'Online', color: '#112233' });
  });

  it('pages: a rename conflict is refused with the online title; a page deleted online refuses the edit', async () => {
    const b = builders(t, me);
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const page = await b.page(cat.id, 'Start');
    const base = baseOf('page', undefined, ['title']);
    expect((await t.http.patch(`/api/pages/${page.id}`).set(me.auth).send({ title: 'Online' })).status).toBe(200);
    const [r] = await batch([{ opId: uuid(), type: 'page.update', id: page.id, title: 'Mine', base }]);
    expect(r).toMatchObject({ ok: false, error: 'conflict' });
    if (r!.ok) throw new Error('unexpected');
    expect(r!.entity).toMatchObject({ kind: 'page', row: { title: 'Online' } });
    await t.http.delete(`/api/pages/${page.id}`).set(me.auth);
    const [gone] = await batch([{ opId: uuid(), type: 'page.update', id: page.id, title: 'Late', base: baseOf('page', undefined, ['title']) }]);
    expect(gone).toMatchObject({ ok: false, error: 'target_deleted' });
  });

  it('a category deleted offline stays when a page in it... only the category counts: a changed category keeps itself', async () => {
    const b = builders(t, me);
    const nb = await b.notebook();
    const cat = await b.category(nb.id, 'Cat');
    expect((await t.http.patch(`/api/categories/${cat.id}`).set(me.auth).send({ name: 'Renamed online' })).status).toBe(200);
    const [r] = await batch([{ opId: uuid(), type: 'category.delete', id: cat.id, base: baseOf('category', undefined, []) }]);
    expect(r).toMatchObject({ ok: false, error: 'deleted_but_changed' });
    expect((await t.prisma.category.findUniqueOrThrow({ where: { id: cat.id } })).deletedAt).toBeNull();
  });
});

// ------------------------------------------------------------------ events

describe('events with a base', () => {
  const newEvent = async (): Promise<EventDto> => {
    const res = await t.http.post('/api/events').set(me.auth).send({ id: uuid(), spaceId: space, title: 'Sync', startAt: '2027-03-15T09:00:00.000Z', endAt: '2027-03-15T10:00:00.000Z', timezone: 'Europe/Lisbon' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as EventDto;
  };

  it('merges a new title with new timing from another device', async () => {
    const ev = await newEvent();
    const base = (keys: string[]) => baseOf('event', ev.fieldSeq, keys);
    expect((await t.http.patch(`/api/events/${ev.id}`).set(me.auth).send({ title: 'Online title' })).status).toBe(200);
    const [r] = await batch([{ opId: uuid(), type: 'event.update', id: ev.id, title: 'My title', startAt: '2027-03-15T11:00:00.000Z', endAt: '2027-03-15T12:00:00.000Z', base: base(['title', 'startAt', 'endAt']) }]);
    expect(r).toMatchObject({ ok: true, status: 'merged', applied: ['timing'] });
    const row = await t.prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.title).toBe('Online title');
    expect(row.startAt.toISOString()).toBe('2027-03-15T11:00:00.000Z');
    expect(row.endAt.toISOString()).toBe('2027-03-15T12:00:00.000Z');
  });

  it('keeps online timing when both changed it; a cancel of a changed event is refused', async () => {
    const ev = await newEvent();
    expect((await t.http.patch(`/api/events/${ev.id}`).set(me.auth).send({ startAt: '2027-03-16T09:00:00.000Z', endAt: '2027-03-16T10:00:00.000Z' })).status).toBe(200);
    const [r] = await batch([{ opId: uuid(), type: 'event.update', id: ev.id, startAt: '2027-03-17T09:00:00.000Z', endAt: '2027-03-17T10:00:00.000Z', base: baseOf('event', ev.fieldSeq, ['startAt', 'endAt']) }]);
    expect(r).toMatchObject({ ok: false, error: 'conflict' });
    const [c] = await batch([{ opId: uuid(), type: 'event.cancel', id: ev.id, scope: 'all', base: baseOf('event', ev.fieldSeq, []) }]);
    expect(c).toMatchObject({ ok: false, error: 'deleted_but_changed' });
    expect((await t.prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).deletedAt).toBeNull();
    // an unchanged event is cancelled
    const other = await newEvent();
    expect((await batch([{ opId: uuid(), type: 'event.cancel', id: other.id, scope: 'all', base: baseOf('event', other.fieldSeq, []) }]))[0]).toMatchObject({ ok: true });
  });
});

describe('what changed between going offline and syncing', () => {
  it('refuses a change to what the person cannot reach, saying no more than for something that does not exist, and the rest of the batch goes on', async () => {
    const { task } = await newTask({ title: 'Mine' });
    // somebody else's task, in a space the person never had
    const stranger = await signup(t);
    const strangerSpace = await personalSpaceId(t, stranger.id);
    const board = await t.http.post(`/api/spaces/${strangerSpace}/boards`).set(stranger.auth).send({ id: uuid(), name: 'Theirs', position: nextPos() });
    const detail = (await t.http.get(`/api/boards/${board.body.id}`).set(stranger.auth)).body as BoardDetailDto;
    const theirs = (await t.http.post(`/api/boards/${board.body.id}/tasks`).set(stranger.auth).send({ id: uuid(), columnId: detail.columns[0]!.id, position: nextPos(), title: 'Secret' })).body as TaskDto;
    const results = await batch([
      { opId: uuid(), type: 'task.update', id: theirs.id, title: 'Hijack', base: { title: 0 } },
      { opId: uuid(), type: 'task.update', id: task.id, title: 'Still works', base: taskBase(task, ['title']) },
    ]);
    const missing = await batch([{ opId: uuid(), type: 'task.update', id: uuid(), title: 'x', base: { title: 0 } }]);
    expect(results[0]).toMatchObject({ ok: false, error: 'target_deleted' });
    expect({ ...results[0], opId: '' }).toEqual({ ...missing[0], opId: '' });
    expect(results[1]).toMatchObject({ ok: true });
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: theirs.id } })).title).toBe('Secret');
  });

  it('answers quota_exceeded for a change that does not fit (it can be sent again) and applies it once there is room', async () => {
    const { task } = await newTask({ title: 'ab' });
    const used = await usedBytesOf(me.id);
    await t.prisma.quotaOverride.create({ data: { id: uuid(), scope: 'user', scopeId: me.id, storageBytes: BigInt(used + 2), updatedBy: me.id } });
    const op = { opId: uuid(), type: 'task.update', id: task.id, title: 'a title that is far too long for the room left', base: taskBase(task, ['title']) };
    expect((await batch([op]))[0]).toMatchObject({ ok: false, error: 'quota_exceeded' });
    expect((await getTask(task.id)).title).toBe('ab');
    await t.prisma.quotaOverride.deleteMany();
    expect((await batch([op]))[0]).toMatchObject({ ok: true, status: 'applied' });
    expect((await getTask(task.id)).title).toBe(op.title);
  });
});

describe('two pushes at the same moment', () => {
  it('end with exactly one winner for the field they both change, and the fields only one of them changed kept', async () => {
    for (let round = 0; round < 6; round++) {
      const { task } = await newTask({ title: 'start' });
      const a = batch([{ opId: uuid(), type: 'task.update', id: task.id, title: 'from A', priority: 'low', base: taskBase(task, ['title', 'priority']) }]);
      const b = batch([{ opId: uuid(), type: 'task.update', id: task.id, title: 'from B', dueAt: '2027-08-01T08:00:00.000Z', base: taskBase(task, ['title', 'dueAt']) }]);
      const [ra, rb] = await Promise.all([a, b]);
      const now = await getTask(task.id);
      const answers = [ra![0]!, rb![0]!];
      const clean = answers.filter((r) => r.ok && r.status === 'applied');
      const merged = answers.filter((r) => r.ok && r.status === 'merged');
      expect(clean.length, JSON.stringify(answers)).toBe(1);
      expect(merged.length, JSON.stringify(answers)).toBe(1);
      expect(['from A', 'from B']).toContain(now.title);
      expect(now.priority).toBe('low');
      expect(now.dueAt).toBe('2027-08-01T08:00:00.000Z');
    }
  });
});

describe('page content from a device (Replace in the Local history)', () => {
  it('puts the document back as one change on top, keeps the page as it was, and needs the right to edit', async () => {
    const b = builders(t, me);
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const page = await b.page(cat.id, 'Replace me');
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'my version' }] }] };
    const res = await t.http.post(`/api/pages/${page.id}/snapshots/replace`).set(me.auth).send({ content: doc });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await t.prisma.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(JSON.stringify(stored.content)).toContain('my version');
    expect(await t.prisma.pageYSnapshot.count({ where: { pageId: page.id } })).toBeGreaterThanOrEqual(1);
    expect((await t.http.post(`/api/pages/${page.id}/snapshots/replace`).set(me.auth).send({ content: { type: 'nonsense' } })).status).toBe(422);
    const stranger = await signup(t);
    expect((await t.http.post(`/api/pages/${page.id}/snapshots/replace`).set(stranger.auth).send({ content: doc })).status).toBe(404);
  });
});

describe('sync pull', () => {
  it('sends fieldSeq with the rows once something was changed', async () => {
    const { task } = await newTask();
    await patchTask(task.id, { priority: 'high' });
    const res = await t.http.get('/api/sync/changes').set(me.auth).query({ cursors: JSON.stringify({ [space]: 0 }) });
    const row = (res.body.spaces[space].tasks as TaskDto[]).find((x) => x.id === task.id)!;
    expect(row.fieldSeq).toEqual({ priority: Number(row.seq) });
  });
});
