import { describe, expect, it } from 'vitest';
import { baseOf, fieldValue, patchFromFields, keysOfField, lastFieldChange, mergeDelete, mergeFieldOf, mergeFieldsOf, mergeUpdate, nextFieldSeq, sameValue, WHOLE, type FieldSeq } from './merge';

describe('merge fields', () => {
  it('groups the keys that must stay consistent', () => {
    expect(mergeFieldsOf('task', ['startAt', 'dueAt', 'allDay'])).toEqual(['dates']);
    expect(mergeFieldsOf('event', ['startAt', 'endAt', 'rrule', 'title'])).toEqual(['timing', 'title']);
    expect(mergeFieldsOf('task', ['columnId', 'position', 'boardId'], 'move')).toEqual(['place']);
    expect(mergeFieldOf('task', 'position')).toBeNull(); // an update never carries a task position
    expect(mergeFieldOf('page', 'position')).toBe('position');
    expect(mergeFieldOf('page', 'constructor')).toBeNull();
    expect(mergeFieldOf('page', 'opId')).toBeNull();
  });

  it('lists the keys of a field and reads its value from a patch or an entity', () => {
    expect(keysOfField('task', 'dates').sort()).toEqual(['allDay', 'dueAt', 'startAt']);
    expect(fieldValue('task', 'title', { title: 'a', priority: 'low' }, 'patch')).toBe('a');
    expect(fieldValue('task', 'dates', { dueAt: 'x' }, 'patch')).toEqual({ dueAt: 'x' });
    expect(fieldValue('task', 'dates', { startAt: null, dueAt: 'y', allDay: false }, 'dto', ['dueAt'])).toEqual({ dueAt: 'y' });
    expect(fieldValue('task', 'completed', { completedAt: '2026-01-01T00:00:00Z' }, 'dto')).toBe(true);
    expect(fieldValue('task', 'completed', { completedAt: null }, 'dto')).toBe(false);
  });

  it('keeps the seq of each field and the newest of them', () => {
    const a = nextFieldSeq(undefined, ['title'], 5);
    const b = nextFieldSeq(a, ['dates', 'priority'], 9);
    expect(b).toEqual({ title: 5, dates: 9, priority: 9 });
    expect(a).toEqual({ title: 5 }); // not changed in place
    expect(lastFieldChange(b)).toBe(9);
    expect(lastFieldChange(null)).toBe(0);
  });

  it('records what a device saw', () => {
    expect(baseOf('task', { title: 4, dates: 7 }, ['title', 'dueAt', 'priority'])).toEqual({ [WHOLE]: 7, title: 4, dates: 7, priority: 0 });
  });

  it('compares values by content', () => {
    expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue('a', 'a')).toBe(true);
  });
});

const server = { title: 'online', priority: 'high', dates: { dueAt: 'D' } };

describe('mergeUpdate', () => {
  const fs: FieldSeq = { title: 10, priority: 3 };

  it('applies a field nobody changed since the device saw it', () => {
    const r = mergeUpdate({ fieldSeq: fs, deleted: false, base: { priority: 3 }, changes: { priority: 'low' }, server });
    expect(r).toEqual({ outcome: 'applied', apply: ['priority'], rejected: {} });
  });

  it('keeps the online value of a field that changed meanwhile', () => {
    const r = mergeUpdate({ fieldSeq: fs, deleted: false, base: { title: 4 }, changes: { title: 'mine' }, server });
    expect(r).toEqual({ outcome: 'rejected', apply: [], rejected: { title: { mine: 'mine', server: 'online', serverSeq: 10 } } });
  });

  it('merges disjoint fields: both sides stay', () => {
    const r = mergeUpdate({ fieldSeq: fs, deleted: false, base: { title: 4, priority: 3, dates: 0 }, changes: { title: 'mine', priority: 'low', dates: { dueAt: 'X' } }, server });
    expect(r.outcome).toBe('merged');
    if (r.outcome === 'target_deleted') throw new Error('unexpected');
    expect(r.apply).toEqual(['dates', 'priority']);
    expect(Object.keys(r.rejected)).toEqual(['title']);
  });

  it('is not a conflict when both sides want the same value', () => {
    const r = mergeUpdate({ fieldSeq: fs, deleted: false, base: { title: 4 }, changes: { title: 'online' }, server });
    expect(r).toEqual({ outcome: 'applied', apply: ['title'], rejected: {} });
  });

  it('applies everything without a base (an old client: the later request wins)', () => {
    const r = mergeUpdate({ fieldSeq: fs, deleted: false, changes: { title: 'mine' }, server });
    expect(r.outcome).toBe('applied');
  });

  it('treats a field that never changed as version 0', () => {
    expect(mergeUpdate({ fieldSeq: undefined, deleted: false, base: { title: 0 }, changes: { title: 'x' }, server }).outcome).toBe('applied');
    expect(mergeUpdate({ fieldSeq: null, deleted: false, base: { title: 0 }, changes: { title: 'x' }, server }).outcome).toBe('applied');
  });

  it('refuses a change to something that was deleted online', () => {
    expect(mergeUpdate({ fieldSeq: fs, deleted: true, base: { title: 10 }, changes: { title: 'x' }, server })).toEqual({ outcome: 'target_deleted' });
  });

  it("does not conflict with the device's own earlier write of the same push", () => {
    const own = { title: 12 };
    const mine = mergeUpdate({ fieldSeq: { title: 12 }, deleted: false, base: { title: 4 }, own, changes: { title: 'second' }, server });
    expect(mine.outcome).toBe('applied');
    // ... but somebody else writing after that does
    const other = mergeUpdate({ fieldSeq: { title: 15 }, deleted: false, base: { title: 4 }, own, changes: { title: 'second' }, server });
    expect(other.outcome).toBe('rejected');
  });

  it('answers the same for the same input', () => {
    const input = { fieldSeq: fs, deleted: false, base: { title: 4, priority: 1 }, changes: { title: 'a', priority: 'b' }, server };
    expect(mergeUpdate(input)).toEqual(mergeUpdate({ ...input, changes: { priority: 'b', title: 'a' } }));
  });

  it('does not depend on the order of ops that touch different fields', () => {
    const run = (order: ('title' | 'priority')[]) => {
      let fieldSeq: FieldSeq = {};
      let seq = 10;
      const values: Record<string, string> = { title: 'old', priority: 'none' };
      for (const f of order) {
        const r = mergeUpdate({ fieldSeq, deleted: false, base: { [f]: 0 }, changes: { [f]: `new-${f}` }, server: values });
        if (r.outcome === 'target_deleted') throw new Error('unexpected');
        for (const applied of r.apply) {
          values[applied] = `new-${applied}`;
          fieldSeq = nextFieldSeq(fieldSeq, [applied], ++seq);
        }
      }
      return values;
    };
    expect(run(['title', 'priority'])).toEqual(run(['priority', 'title']));
  });
});

describe('mergeDelete', () => {
  it('deletes what nobody changed since the device saw it', () => {
    expect(mergeDelete({ fieldSeq: { title: 5 }, deleted: false, base: { [WHOLE]: 5 } })).toBe('apply');
    expect(mergeDelete({ fieldSeq: undefined, deleted: false, base: { [WHOLE]: 0 } })).toBe('apply');
  });
  it('keeps what changed online after the device saw it', () => {
    expect(mergeDelete({ fieldSeq: { title: 6 }, deleted: false, base: { [WHOLE]: 5 } })).toBe('deleted_but_changed');
  });
  it('succeeds when it is already deleted', () => {
    expect(mergeDelete({ fieldSeq: { title: 6 }, deleted: true, base: { [WHOLE]: 5 } })).toBe('already');
  });
  it('deletes without a base', () => {
    expect(mergeDelete({ fieldSeq: { title: 6 }, deleted: false })).toBe('apply');
  });
  it("ignores the device's own earlier writes", () => {
    expect(mergeDelete({ fieldSeq: { title: 9 }, deleted: false, base: { [WHOLE]: 5 }, own: { title: 9 } })).toBe('apply');
  });
});

/**
 * Property: two devices change the same entity offline and push in either order. For every field that both changed, exactly one
 * value wins (the one pushed first); fields only one side changed always survive; the result depends only on the push order.
 */
describe('two devices', () => {
  const FIELDS = ['title', 'priority', 'dates', 'checklist'] as const;
  let state = 123456789;
  const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);

  it('gives one winner per conflicting field and keeps the rest, in any push order', () => {
    for (let round = 0; round < 300; round++) {
      const pick = () => FIELDS.filter(() => rand() < 0.5);
      const a = pick();
      const b = pick();
      const first = rand() < 0.5 ? 'a' : 'b';
      const values: Record<string, string> = { title: 'v0', priority: 'v0', dates: 'v0', checklist: 'v0' };
      let fieldSeq: FieldSeq = {};
      let seq = 0;
      const push = (who: 'a' | 'b', fields: readonly string[]) => {
        const r = mergeUpdate({
          fieldSeq,
          deleted: false,
          base: Object.fromEntries(fields.map((f) => [f, 0])),
          changes: Object.fromEntries(fields.map((f) => [f, `${who}-${f}`])),
          server: values,
        });
        if (r.outcome === 'target_deleted') throw new Error('unexpected');
        seq++;
        for (const f of r.apply) values[f] = `${who}-${f}`;
        fieldSeq = nextFieldSeq(fieldSeq, r.apply, seq);
        return r;
      };
      const second = first === 'a' ? 'b' : 'a';
      const fields = { a, b };
      push(first, fields[first]);
      push(second, fields[second]);
      for (const f of FIELDS) {
        const inA = a.includes(f);
        const inB = b.includes(f);
        if (inA && inB) expect(values[f]).toBe(`${first}-${f}`); // the one that got there first
        else if (inA) expect(values[f]).toBe(`a-${f}`);
        else if (inB) expect(values[f]).toBe(`b-${f}`);
        else expect(values[f]).toBe('v0');
      }
    }
  });
});

describe('patchFromFields', () => {
  it('turns merge fields back into the keys of an update', () => {
    expect(patchFromFields('task', { title: 'x', dates: { dueAt: 'D', allDay: false }, completed: true })).toEqual({ title: 'x', dueAt: 'D', allDay: false, completed: true });
    expect(patchFromFields('event', { timing: { startAt: 'a', endAt: 'b' } })).toEqual({ startAt: 'a', endAt: 'b' });
  });
});
