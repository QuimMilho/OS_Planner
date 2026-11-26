import { Injectable, inject } from '@angular/core';
import { Subject } from 'rxjs';
import type { SyncOp } from '@os-planner/shared';
import { Db } from './db';

/** Queue of changes made locally that the server has not seen yet, sent in order by Sync. */
@Injectable({ providedIn: 'root' })
export class Outbox {
  private readonly dbs = inject(Db);
  /** Emits after every enqueue; Sync listens (debounced) and other tabs are told via BroadcastChannel. */
  readonly changed = new Subject<void>();

  /**
   * Adds an operation. An update to something that still has a not-yet-sent create/update is
   * folded into that operation (a rename burst becomes one request, and an item created and
   * renamed offline is simply created with its final name). Order against deletes is preserved.
   */
  async enqueue(op: SyncOp): Promise<void> {
    const db = this.dbs.db;
    await db.transaction('rw', db.outbox, async () => {
      if (op.type.endsWith('.update')) {
        const entity = op.type.split('.')[0];
        const rows = await db.outbox.toArray();
        for (let i = rows.length - 1; i >= 0; i--) {
          const queued = rows[i]!.op as { id?: string; type: string };
          if (queued.id !== (op as { id: string }).id) continue;
          if (queued.type.startsWith(`${entity}.`) && (queued.type.endsWith('.create') || queued.type.endsWith('.update'))) {
            const { opId: _o, type: _t, id: _i, ...patch } = op as unknown as Record<string, unknown>;
            await db.outbox.update(rows[i]!.n!, { op: { ...rows[i]!.op, ...patch } as SyncOp });
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
