import { Injectable, inject } from '@angular/core';
import { Db } from './db';
import { liveSignal } from './live';

const KEY = 'offlineExcluded';

/**
 * Which spaces keep the texts of their pages on this device (Settings -> Offline). Notebooks, boards, tasks and the calendar are
 * always kept; the texts of pages are the heavy part, so a space can be left out: its pages are then fetched when opened.
 */
@Injectable({ providedIn: 'root' })
export class OfflineScope {
  private readonly dbs = inject(Db);

  /** The spaces left out. */
  readonly excluded = liveSignal(this.dbs, async (d) => ((await d.meta.get(KEY))?.value as string[] | undefined) ?? [], [] as string[]);

  async excludedNow(): Promise<Set<string>> {
    if (!this.dbs.current()) return new Set();
    return new Set(((await this.dbs.db.meta.get(KEY))?.value as string[] | undefined) ?? []);
  }

  async keep(spaceId: string, keep: boolean): Promise<void> {
    const out = await this.excludedNow();
    if (keep) out.delete(spaceId);
    else out.add(spaceId);
    await this.dbs.db.meta.put({ key: KEY, value: [...out] });
  }
}
