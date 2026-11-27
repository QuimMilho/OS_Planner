import { AsyncLocalStorage } from 'node:async_hooks';
import {
  fieldValue,
  keysOfField,
  mergeDelete,
  mergeFieldsOf,
  mergeUpdate,
  nextFieldSeq,
  sameValue,
  type FieldSeq,
  type MergeBase,
  type MergeEntity,
  type RejectedField,
} from '@os-planner/shared';

/**
 * Offline merge (phase 15), seen from the services that write.
 *
 * A change arriving through `POST /api/sync/batch` runs inside a `MergeScope` (set by SyncService with AsyncLocalStorage): what the
 * device saw when it made the change (`base`) and what earlier ops of the same push already wrote. A service that changes a
 * tracked entity asks `guardUpdate` / `guardDelete` *inside its write transaction, after taking the space lock*, so the decision
 * and the write cannot be separated by another writer. Outside a scope (REST, collaboration, ...) the guards allow everything and
 * only keep `fieldSeq` up to date, which is what lets a later push notice that the field changed.
 */
export interface MergeScope {
  /** What the device saw, for the entity this op is about. */
  base: MergeBase | undefined;
  /** What this push already wrote, entity id → merge field → seq (a device never conflicts with itself). */
  own: Map<string, FieldSeq>;
  /** Filled by the guards: the fields that were written and the ones that lost. */
  result: { applied: string[]; rejected: Record<string, RejectedField>; merged: boolean };
}

export const mergeScope = new AsyncLocalStorage<MergeScope>();

/** The change was not applied; the transaction it was thrown in rolls back, so nothing of it is left. */
export class MergeRejected extends Error {
  constructor(
    readonly code: 'conflict' | 'target_deleted' | 'deleted_but_changed',
    readonly rejected: Record<string, RejectedField> = {},
  ) {
    super(code);
  }
}

interface Row {
  id: string;
  fieldSeq: unknown;
  deletedAt: Date | null;
}

const asFieldSeq = (v: unknown): FieldSeq | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as FieldSeq) : null);

/** `{ fieldSeq }` for a DTO when the stored entity has any (an entity nobody changed since it was made has none). */
export const fieldSeqDto = (v: unknown): { fieldSeq?: FieldSeq } => {
  const fs = asFieldSeq(v);
  return fs && Object.keys(fs).length ? { fieldSeq: fs } : {};
};

/** The keys of `patch` that ask for something other than what `current` holds. */
export function changedKeys(patch: Record<string, unknown>, current: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(patch).filter((k) => patch[k] !== undefined && !sameValue(patch[k], current[k])));
}

export interface Guarded {
  /** The patch keys that may be written. */
  keys: Set<string>;
  /** The merge fields they belong to (what `fieldSeq` records). */
  fields: string[];
  /** `fieldSeq` to store with the write at `seq`. */
  next(seq: bigint): FieldSeq;
}

/**
 * Decides which of the keys a service is about to change may really be written.
 * `wanted`: the patch keys that differ from the stored values; `patch`: the values asked for; `server`: the entity as it is now.
 * Throws `MergeRejected` when nothing of it may be written.
 */
export function guardUpdate(entity: MergeEntity, row: Row, wanted: ReadonlySet<string>, patch: Record<string, unknown>, server: Record<string, unknown>, kind: 'update' | 'move' = 'update'): Guarded {
  const scope = mergeScope.getStore();
  const stored = asFieldSeq(row.fieldSeq);
  const all = (): Guarded => {
    const fields = mergeFieldsOf(entity, wanted, kind);
    return { keys: new Set(wanted), fields, next: (seq) => nextFieldSeq(stored, fields, Number(seq)) };
  };
  if (!scope) return all();

  const fields = mergeFieldsOf(entity, wanted, kind);
  const keysOf = (f: string) => keysOfField(entity, f).filter((k) => wanted.has(k));
  const changes: Record<string, unknown> = {};
  const online: Record<string, unknown> = {};
  for (const f of fields) {
    const keys = keysOf(f);
    changes[f] = fieldValue(entity, f, patch, 'patch');
    online[f] = fieldValue(entity, f, server, 'dto', keys);
  }
  const res = mergeUpdate({ fieldSeq: stored, deleted: !!row.deletedAt, base: scope.base, own: scope.own.get(row.id), changes, server: online });
  if (res.outcome === 'target_deleted') throw new MergeRejected('target_deleted');
  if (res.outcome === 'rejected') throw new MergeRejected('conflict', res.rejected);
  scope.result.rejected = res.rejected;
  scope.result.merged = Object.keys(res.rejected).length > 0;
  scope.result.applied = res.apply;
  const keys = new Set([...wanted].filter((k) => res.apply.includes(mergeFieldsOf(entity, [k], kind)[0] ?? '')));
  return {
    keys,
    fields: res.apply,
    next: (seq) => {
      const out = nextFieldSeq(stored, res.apply, Number(seq));
      scope.own.set(row.id, nextFieldSeq(scope.own.get(row.id), res.apply, Number(seq)));
      return out;
    },
  };
}

/** A delete (or a cancel): returns false when it is already gone, throws `MergeRejected` when the entity changed after the device saw it. */
export function guardDelete(row: Row): boolean {
  const scope = mergeScope.getStore();
  const verdict = mergeDelete({ fieldSeq: asFieldSeq(row.fieldSeq), deleted: !!row.deletedAt, base: scope?.base, own: scope ? Object.fromEntries(Object.entries(scope.own.get(row.id) ?? {})) : undefined });
  if (verdict === 'already') return false;
  if (verdict === 'deleted_but_changed') throw new MergeRejected('deleted_but_changed');
  return true;
}

/** A write that changed the entity without going through `guardUpdate` (a restore, a move of a whole subtree): keep `own` and `fieldSeq` honest. */
export function noteWrite(id: string, fields: readonly string[], seq: bigint): void {
  const scope = mergeScope.getStore();
  if (scope) scope.own.set(id, nextFieldSeq(scope.own.get(id), fields, Number(seq)));
}
