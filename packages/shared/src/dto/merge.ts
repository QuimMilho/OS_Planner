// Offline merge (phase 15): per-field versions and the rules that decide, field by field, whether a change that was made on a
// device that was not connected can be applied. No dependencies, so the server and the web share exactly the same code.
//
//  * Every entity that can be changed offline carries `fieldSeq`: for each *merge field* the space `seq` at which it last changed
//    (a field that never changed is absent = 0).
//  * A pushed change lists the merge fields it touches and, in `base`, the `fieldSeq` the device saw when it made the change.
//  * A field whose server version is newer than the base was changed by somebody else meanwhile: the server's value stays and the
//    local one is handed back (`rejected`). Fields nobody else touched are applied. The base key `*` stands for "the whole
//    entity" (used by deletes: anything changed after it keeps the entity).

/** The entities whose fields merge. */
export type MergeEntity = 'notebook' | 'category' | 'page' | 'task' | 'event';

/** Merge field → the seq at which it last changed. */
export type FieldSeq = Record<string, number>;
/** Merge field → the `fieldSeq` the device saw (and `*` for the entity as a whole). */
export type MergeBase = Record<string, number>;

/** What a conflicting field looked like on each side. */
export interface RejectedField {
  /** The value the device wanted. */
  mine: unknown;
  /** The value that is online (and stays). */
  server: unknown;
  /** The seq at which the online value was written. */
  serverSeq: number;
}

/** The base key that stands for the whole entity. */
export const WHOLE = '*';

/**
 * Patch field → merge field. Fields that must stay consistent with each other travel as one merge field: the dates of a task
 * (a due date before the start is refused), the timing of an event, and the place of a task (column and position).
 */
const GROUPS: Record<MergeEntity, Record<string, string>> = {
  notebook: { name: 'name', icon: 'icon', color: 'color', position: 'position' },
  category: { name: 'name', parentId: 'parentId', position: 'position' },
  page: { title: 'title', categoryId: 'categoryId', position: 'position' },
  task: {
    title: 'title',
    description: 'description',
    priority: 'priority',
    startAt: 'dates',
    dueAt: 'dates',
    allDay: 'dates',
    completed: 'completed',
    assigneeIds: 'assigneeIds',
    labelIds: 'labelIds',
    checklist: 'checklist',
    // a move
    columnId: 'place',
    boardId: 'place',
  },
  event: {
    title: 'title',
    description: 'description',
    location: 'location',
    videoUrl: 'videoUrl',
    kind: 'kind',
    visibility: 'visibility',
    linkedChannelId: 'linkedChannelId',
    startAt: 'timing',
    endAt: 'timing',
    allDay: 'timing',
    timezone: 'timing',
    rrule: 'timing',
  },
};

/** The merge field a patch key belongs to, or null for a key that does not merge (ids, scope, ...). */
export function mergeFieldOf(entity: MergeEntity, key: string, kind: 'update' | 'move' = 'update'): string | null {
  // A move's `position` is part of the place; an update's `position` (a notebook, category or page being reordered) is its own field.
  if (entity === 'task' && kind === 'move' && key === 'position') return 'place';
  return Object.hasOwn(GROUPS[entity], key) ? GROUPS[entity][key]! : null;
}

/** The merge fields a set of patch keys touches. */
export function mergeFieldsOf(entity: MergeEntity, keys: Iterable<string>, kind: 'update' | 'move' = 'update'): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    const field = mergeFieldOf(entity, key, kind);
    if (field) out.add(field);
  }
  return [...out];
}

/** The patch keys that make up one merge field (for showing and re-applying it). */
export function keysOfField(entity: MergeEntity, field: string): string[] {
  const keys = Object.entries(GROUPS[entity]).filter(([, f]) => f === field).map(([k]) => k);
  if (entity === 'task' && field === 'place') keys.push('position');
  return keys;
}

/** The patch the way the server and the client read a stored value: what each patch key looks like in the entity. */
const FROM_DTO: Partial<Record<MergeEntity, Record<string, (dto: Record<string, unknown>) => unknown>>> = {
  task: { completed: (d) => d['completedAt'] != null },
};

/** The value a patch key has in an entity (the DTO the server sends), so it can be compared with what a device wanted. */
export function dtoValue(entity: MergeEntity, dto: Record<string, unknown>, key: string): unknown {
  const read = FROM_DTO[entity]?.[key];
  return read ? read(dto) : dto[key];
}

/** The value of one merge field, from a patch (`mine`) or from the entity's DTO (`server`): a plain value, or an object for a group. */
export function fieldValue(entity: MergeEntity, field: string, source: Record<string, unknown>, from: 'patch' | 'dto', keysIn?: readonly string[]): unknown {
  const keys = keysOfField(entity, field).filter((k) => (from === 'patch' ? source[k] !== undefined : keysIn ? keysIn.includes(k) : true));
  const read = (k: string) => (from === 'dto' ? dtoValue(entity, source, k) : source[k]);
  if (keys.length === 1 && keys[0] === field) return read(field);
  if (field === 'completed') return read('completed');
  return Object.fromEntries(keys.map((k) => [k, read(k)]));
}

/** `fieldSeq` after the given fields changed at `seq`. */
export function nextFieldSeq(prev: FieldSeq | null | undefined, fields: Iterable<string>, seq: number): FieldSeq {
  const out: FieldSeq = { ...(prev ?? {}) };
  for (const f of fields) out[f] = seq;
  return out;
}

/** The newest change of any field (0 for an entity nobody changed since it was made). */
export function lastFieldChange(fieldSeq: FieldSeq | null | undefined): number {
  let max = 0;
  for (const v of Object.values(fieldSeq ?? {})) if (v > max) max = v;
  return max;
}

/** What a device records when it makes a change: the `fieldSeq` it saw for each merge field it touches, and for the entity as a whole. */
export function baseOf(entity: MergeEntity, fieldSeq: FieldSeq | null | undefined, keys: Iterable<string>, kind: 'update' | 'move' = 'update'): MergeBase {
  const base: MergeBase = { [WHOLE]: lastFieldChange(fieldSeq) };
  for (const f of mergeFieldsOf(entity, keys, kind)) base[f] = fieldSeq?.[f] ?? 0;
  return base;
}

/** Stable JSON equality (key order does not matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameValue(v, (b as unknown[])[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export type MergeOutcome = 'applied' | 'merged' | 'rejected';

export type MergeResult =
  | { outcome: 'target_deleted' }
  | {
      outcome: MergeOutcome;
      /** The merge fields to write. */
      apply: string[];
      /** The ones that lost, with both values. */
      rejected: Record<string, RejectedField>;
    };

export interface MergeInput {
  /** The entity as it is online. */
  fieldSeq: FieldSeq | null | undefined;
  /** The entity is in the trash (or gone). */
  deleted: boolean;
  /** What the device saw; without it (an old client, REST) nothing is checked and the change is applied. */
  base?: MergeBase | null;
  /** Writes of the same push that came earlier (the device's own, so they never conflict with its later changes): field → seq. */
  own?: FieldSeq | null;
  /** The device's change: merge field → the value it wants. */
  changes: Record<string, unknown>;
  /** The entity's value for each of those fields, as it is online. */
  server: Record<string, unknown>;
}

/**
 * Decides, field by field, what a change from a device does to an entity. Pure: the same input gives the same answer.
 *  - the entity is gone                                → `target_deleted` (it stays gone)
 *  - nobody changed a field since the device saw it    → applied
 *  - somebody did and the values differ                → rejected, the online value stays
 *  - fields nobody else touched                        → applied even when others were rejected (`merged`)
 */
export function mergeUpdate(input: MergeInput): MergeResult {
  if (input.deleted) return { outcome: 'target_deleted' };
  const apply: string[] = [];
  const rejected: Record<string, RejectedField> = {};
  for (const field of Object.keys(input.changes).sort()) {
    const base = input.base?.[field];
    const online = input.fieldSeq?.[field] ?? 0;
    const known = Math.max(base ?? 0, input.own?.[field] ?? 0);
    if (base !== undefined && online > known && !sameValue(input.changes[field], input.server[field])) {
      rejected[field] = { mine: input.changes[field], server: input.server[field], serverSeq: online };
    } else apply.push(field);
  }
  const lost = Object.keys(rejected).length;
  return { outcome: !lost ? 'applied' : apply.length ? 'merged' : 'rejected', apply, rejected };
}

export type DeleteResult = 'apply' | 'already' | 'deleted_but_changed';

/** A delete: fine when the entity is already gone; refused (the entity stays) when something changed online after the device saw it. */
export function mergeDelete(input: { fieldSeq: FieldSeq | null | undefined; deleted: boolean; base?: MergeBase | null; own?: FieldSeq | null }): DeleteResult {
  if (input.deleted) return 'already';
  const base = input.base?.[WHOLE];
  if (base === undefined) return 'apply';
  return lastFieldChange(input.fieldSeq) > Math.max(base, lastFieldChange(input.own)) ? 'deleted_but_changed' : 'apply';
}

/** The patch (the keys an update op carries) that asks for the given merge fields to have the given values: the inverse of `fieldValue` on a patch. */
export function patchFromFields(entity: MergeEntity, fields: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    const keys = keysOfField(entity, field);
    if (field === 'completed' || (keys.length === 1 && keys[0] === field)) patch[field] = value;
    else if (value && typeof value === 'object') Object.assign(patch, value);
  }
  return patch;
}
