import { effect, signal, type Signal } from '@angular/core';
import { liveQuery } from 'dexie';
import { from } from 'rxjs';
import type { Db, NotesDb } from './db';

/**
 * A signal that always holds the current result of a Dexie query and updates whenever the
 * tables it reads change (in this tab or another). Re-subscribes if a different user's database is opened.
 * Must be called in an injection context.
 */
export function liveSignal<T>(db: Db, query: (db: NotesDb) => Promise<T>, initial: T): Signal<T> {
  const out = signal<T>(initial);
  effect((onCleanup) => {
    const current = db.current();
    if (!current) {
      out.set(initial);
      return;
    }
    const sub = from(liveQuery(() => query(current))).subscribe({
      next: (value) => out.set(value),
      error: (e) => console.error('live query failed', e),
    });
    onCleanup(() => sub.unsubscribe());
  });
  return out;
}
