import { Injectable, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { baseOf, type MergeBase, type MergeEntity } from '@os-planner/shared/lite';
import type { SyncOp } from '@os-planner/shared';
import { Db, type PlannerDb } from './db';
import { liveSignal } from './live';

/** The entities whose changes merge field by field, and where this device keeps them. */
const TABLE: Record<MergeEntity, 'notebooks' | 'categories' | 'pages' | 'tasks' | 'events'> = {
  notebook: 'notebooks',
  category: 'categories',
  page: 'pages',
  task: 'tasks',
  event: 'events',
};
const NOT_PATCH = new Set(['opId', 'type', 'id', 'base', 'scope', 'occurrence']);

/** The merge entity an op is about, with what kind of change it is (null for ops that do not merge: creates, restores, answers). */
export function mergeKindOf(op: SyncOp): { entity: MergeEntity; kind: 'update' | 'move' | 'delete' } | null {
  const [entity, verb] = op.type.split('.') as [string, string];
  if (!(entity in TABLE)) return null;
  // One occurrence of a series (or the rest of it) is not merged: it is its own change.
  if (entity === 'event' && 'scope' in op && op.scope && op.scope !== 'all') return null;
  if (verb === 'update' || verb === 'move') return { entity: entity as MergeEntity, kind: verb };
  if (verb === 'delete' || verb === 'cancel') return { entity: entity as MergeEntity, kind: 'delete' };
  return null;
}

/** What this device saw of the entity an op changes: the version of each field it touches (see merge.ts in the shared package). */
export async function baseFor(db: PlannerDb, op: SyncOp): Promise<MergeBase | undefined> {
  const k = mergeKindOf(op);
  if (!k || !('id' in op)) return undefined;
  const row = (await db.table(TABLE[k.entity]).get(op.id)) as { fieldSeq?: Record<string, number> } | undefined;
  if (!row) return undefined;
  const keys = k.kind === 'delete' ? [] : Object.keys(op).filter((key) => !NOT_PATCH.has(key));
  return baseOf(k.entity, row.fieldSeq, keys, k.kind === 'move' ? 'move' : 'update');
}

/** Queue of changes made locally that the server has not seen yet, sent in order by Sync. */
@Injectable({ providedIn: 'root' })
export class Outbox {
  private readonly dbs = inject(Db);
  /** Emits after every enqueue; Sync listens (debounced) and other tabs are told via BroadcastChannel. */
  readonly changed = new Subject<void>();
  /** The ids of what has changes that were not sent yet (they get a dot where they are listed). */
  readonly pendingIds = liveSignal(this.dbs, async (d) => new Set((await d.outbox.toArray()).map((o) => ('id' in o.op ? o.op.id : ''))), new Set<string>());

  /**
   * Adds an operation. An update to something that still has a not-yet-sent create/update is
   * folded into that operation (a rename burst becomes one request, and an item created and
   * renamed offline is simply created with its final name). Order against deletes is preserved.
   */
  async enqueue(op: SyncOp): Promise<void> {
    const db = this.dbs.db;
    // Offline merge: what this device saw of the thing it is changing travels with the change (before any local write can alter it).
    const base = 'base' in op && op.base ? op.base : await baseFor(db, op);
    if (base) op = { ...op, base } as SyncOp;
    await db.transaction('rw', db.outbox, async () => {
      // An event change for one occurrence (or the rest of a series) is its own request; only a plain change of the whole event folds into a not-yet-sent create.
      const foldable = op.type !== 'event.update' || !('scope' in op) || op.scope === undefined || op.scope === 'all';
      if (op.type.endsWith('.update') && foldable) {
        const entity = op.type.split('.')[0];
        const rows = await db.outbox.toArray();
        for (let i = rows.length - 1; i >= 0; i--) {
          const queued = rows[i]!.op as { id?: string; type: string };
          if (queued.id !== (op as { id: string }).id) continue;
          if (entity === 'event' && queued.type !== 'event.create') break; // events fold only into their own create
          if (queued.type.startsWith(`${entity}.`) && (queued.type.endsWith('.create') || queued.type.endsWith('.update'))) {
            const { opId: _o, type: _t, id: _i, scope: _s, occurrence: _c, base: newBase, ...patch } = op as unknown as Record<string, unknown>;
            // The change that was queued first keeps what it was based on; the fields added now bring theirs.
            const oldBase = (rows[i]!.op as { base?: MergeBase }).base;
            const merged = oldBase && newBase ? { ...(newBase as MergeBase), ...oldBase } : oldBase;
            await db.outbox.update(rows[i]!.n!, { op: { ...rows[i]!.op, ...patch, ...(merged ? { base: merged } : {}) } as SyncOp });
            return;
          }
          break; // a delete/restore sits in between: keep the order, append instead
        }
      }
      await db.outbox.add({ op });
    });
    this.changed.next();
  }
}
