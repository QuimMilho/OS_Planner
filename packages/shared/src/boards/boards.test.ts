import { describe, expect, it } from 'vitest';
import { comparePositions, evenPositions, positionBetween, POSITION_REBALANCE_LENGTH } from '../dto/position';
import { createTaskSchema, moveTaskSchema, updateTaskSchema, type TaskDto } from '../dto/boards';
import { syncOpSchema } from '../dto/sync';
import { contrastRatio, LABEL_COLORS, textColorOn } from './color';
import { taskDocFromText, taskDocText, validateTaskDescription } from './description';
import { compareByDue, dateInZone, dueState, groupByDue } from './due';

const ID = '018f0000-0000-7000-8000-000000000001';
const ID2 = '018f0000-0000-7000-8000-000000000002';

const task = (over: Partial<TaskDto>): TaskDto => ({
  id: ID,
  boardId: ID,
  columnId: ID,
  spaceId: ID,
  parentTaskId: null,
  title: 'T',
  description: null,
  position: 'a0',
  priority: 'none',
  startAt: null,
  dueAt: null,
  allDay: false,
  completedAt: null,
  assigneeIds: [],
  labelIds: [],
  checklist: [],
  commentCount: 0,
  attachmentCount: 0,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  seq: 1,
  deletedAt: null,
  ...over,
});

describe('fractional positions', () => {
  it('keeps the order after many inserts between the same two neighbours', () => {
    const a = positionBetween(null, null);
    const z = positionBetween(a, null);
    // Always insert right after `a` (between a and the previous insert): the worst case for key growth.
    const keys = [a, z];
    let upper = z;
    for (let i = 0; i < 500; i++) {
      const k = positionBetween(a, upper);
      expect(k > a && k < upper).toBe(true);
      keys.splice(1, 0, k);
      upper = k;
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('re-keys a list that got too long without changing its order', () => {
    const a = positionBetween(null, null);
    const z = positionBetween(a, null);
    let rows = [
      { id: 'a', position: a },
      { id: 'z', position: z },
    ];
    let rebalances = 0;
    for (let i = 0; i < 600; i++) {
      const position = positionBetween(rows[0]!.position, rows[1]!.position);
      rows.splice(1, 0, { id: `n${i}`, position });
      if (position.length > POSITION_REBALANCE_LENGTH) {
        const fresh = evenPositions(rows.length);
        rows = rows.map((r, n) => ({ ...r, position: fresh[n]! }));
        rebalances++;
      }
      expect(Math.max(...rows.map((r) => r.position.length))).toBeLessThanOrEqual(64);
    }
    expect(rebalances).toBeGreaterThan(0);
    expect([...rows].sort(comparePositions).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(rows[0]!.id).toBe('a');
    expect(rows.at(-1)!.id).toBe('z');
  });

  it('breaks ties by id so every client shows the same order', () => {
    const rows = [
      { id: 'b', position: 'a0' },
      { id: 'a', position: 'a0' },
      { id: 'c', position: 'Zz' },
    ];
    expect(rows.sort(comparePositions).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the order for random inserts anywhere', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const keys: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const at = Math.floor(rnd() * (keys.length + 1));
      const k = positionBetween(keys[at - 1] ?? null, keys[at] ?? null);
      keys.splice(at, 0, k);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('task description', () => {
  const p = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });

  it('accepts the reduced document', () => {
    const doc = {
      type: 'doc',
      content: [
        p('Hello', [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }]),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('one'), { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p('nested')] }] }] }] },
      ],
    };
    const res = validateTaskDescription(doc);
    expect(res.ok).toBe(true);
    expect(taskDocText(doc as never)).toBe('Hello one nested');
  });

  it('treats nothing and an empty document as no description', () => {
    expect(validateTaskDescription(null)).toEqual({ ok: true, doc: null, bytes: 0 });
    expect(validateTaskDescription({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual({ ok: true, doc: null, bytes: 0 });
  });

  it.each([
    ['an image', { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId: ID } }] }],
    ['a heading', { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'x' }] }] }],
    ['a script link', { type: 'doc', content: [p('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])] }],
    ['a data link', { type: 'doc', content: [p('x', [{ type: 'link', attrs: { href: 'data:text/html,hi' } }])] }],
    ['an unknown mark', { type: 'doc', content: [p('x', [{ type: 'highlight' }])] }],
    ['an unknown attribute', { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'x' }] }] }],
    ['text outside a paragraph', { type: 'doc', content: [{ type: 'text', text: 'x' }] }],
    ['an empty list', { type: 'doc', content: [{ type: 'bulletList', content: [] }] }],
    ['a bare string', 'hello'],
    ['an array', []],
  ])('refuses %s', (_name, doc) => {
    expect(validateTaskDescription(doc).ok).toBe(false);
  });

  it('refuses a document that is too deep, too big or has too many nodes', () => {
    let deep: unknown = p('x');
    for (let i = 0; i < 10; i++) deep = { type: 'bulletList', content: [{ type: 'listItem', content: [deep] }] };
    expect(validateTaskDescription({ type: 'doc', content: [deep] }).ok).toBe(false);
    expect(validateTaskDescription({ type: 'doc', content: [p('x'.repeat(25_000))] }).ok).toBe(false);
    expect(validateTaskDescription({ type: 'doc', content: Array.from({ length: 2500 }, () => p('x')) }).ok).toBe(false);
  });

  it('builds a description from plain text', () => {
    expect(taskDocText(taskDocFromText('one\ntwo'))).toBe('one two');
    expect(taskDocFromText('  ')).toBeNull();
  });
});

describe('due dates', () => {
  // Wednesday 2026-03-11 12:00 UTC
  const now = Date.parse('2026-03-11T12:00:00.000Z');

  it('classifies timed tasks against the instant and the day', () => {
    expect(dueState(task({ dueAt: '2026-03-11T09:00:00.000Z' }), now)).toBe('overdue');
    expect(dueState(task({ dueAt: '2026-03-11T18:00:00.000Z' }), now)).toBe('today');
    expect(dueState(task({ dueAt: '2026-03-12T09:00:00.000Z' }), now)).toBe('upcoming');
    expect(dueState(task({ dueAt: null }), now)).toBe('none');
  });

  it('classifies all-day tasks by their calendar day', () => {
    expect(dueState(task({ dueAt: '2026-03-10T00:00:00.000Z', allDay: true }), now)).toBe('overdue');
    expect(dueState(task({ dueAt: '2026-03-11T00:00:00.000Z', allDay: true }), now)).toBe('today');
    expect(dueState(task({ dueAt: '2026-03-12T00:00:00.000Z', allDay: true }), now)).toBe('upcoming');
  });

  it('reads "today" in the viewer time zone', () => {
    // 23:30 UTC is already the next day in Lisbon summer time (+60) and still the same day in New York (-300).
    const late = Date.parse('2026-07-01T23:30:00.000Z');
    expect(dateInZone(late, 60)).toBe('2026-07-02');
    expect(dateInZone(late, -300)).toBe('2026-07-01');
    expect(dueState(task({ dueAt: '2026-07-02T00:00:00.000Z', allDay: true }), late, 60)).toBe('today');
    expect(dueState(task({ dueAt: '2026-07-02T00:00:00.000Z', allDay: true }), late, -300)).toBe('upcoming');
  });

  it('ignores the due date of a finished task', () => {
    expect(dueState(task({ dueAt: '2026-03-01T00:00:00.000Z', completedAt: '2026-03-02T00:00:00.000Z' }), now)).toBe('none');
  });

  it('groups in order and sorts each group by due date', () => {
    const items = [
      task({ id: ID, title: 'b', dueAt: '2026-03-20T00:00:00.000Z', allDay: true }),
      task({ id: ID2, title: 'a', dueAt: '2026-03-01T00:00:00.000Z', allDay: true }),
      task({ id: '018f0000-0000-7000-8000-000000000003', title: 'n' }),
      task({ id: '018f0000-0000-7000-8000-000000000004', title: 't', dueAt: '2026-03-11T00:00:00.000Z', allDay: true }),
      task({ id: '018f0000-0000-7000-8000-000000000005', title: 'a2', dueAt: '2026-03-05T00:00:00.000Z', allDay: true }),
    ].map((t) => ({ task: t }));
    const groups = groupByDue(items, now);
    expect(groups.map((g) => g.state)).toEqual(['overdue', 'today', 'upcoming', 'none']);
    expect(groups[0]!.items.map((i) => i.task.title)).toEqual(['a', 'a2']);
    expect(compareByDue(task({ dueAt: null }), task({ dueAt: '2026-01-01T00:00:00.000Z' }))).toBe(1);
  });
});

describe('label colours', () => {
  it('picks a readable text colour for every palette colour', () => {
    for (const c of LABEL_COLORS) expect(contrastRatio(c, textColorOn(c))).toBeGreaterThanOrEqual(4.5);
    expect(textColorOn('#ffffff')).toBe('#000000');
    expect(textColorOn('#000000')).toBe('#ffffff');
  });
});

describe('task schemas', () => {
  it('create needs a title, a column and a position; update takes any subset', () => {
    expect(createTaskSchema.safeParse({ id: ID, columnId: ID, position: 'a0', title: 'x' }).success).toBe(true);
    expect(createTaskSchema.safeParse({ id: ID, columnId: ID, position: 'a0' }).success).toBe(false);
    expect(updateTaskSchema.safeParse({}).success).toBe(true);
    expect(updateTaskSchema.safeParse({ priority: 'urgent', dueAt: null }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ priority: 'meh' }).success).toBe(false);
    expect(moveTaskSchema.safeParse({ columnId: ID, position: 'a1' }).success).toBe(true);
  });

  it('knows the offline task operations', () => {
    const ops = [
      { opId: ID, type: 'task.create', boardId: ID, id: ID2, columnId: ID, position: 'a0', title: 'x' },
      { opId: ID, type: 'task.update', id: ID2, title: 'y' },
      { opId: ID, type: 'task.move', id: ID2, columnId: ID, position: 'a1' },
      { opId: ID, type: 'task.delete', id: ID2 },
      { opId: ID, type: 'task.restore', id: ID2 },
    ];
    for (const op of ops) expect(syncOpSchema.safeParse(op).success, op.type).toBe(true);
  });
});
