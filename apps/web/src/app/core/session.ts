import { Injectable, effect, inject, untracked } from '@angular/core';
import { AuthStore } from './auth-store';
import { Db } from '../data/db';
import { MediaStore } from '../data/media-store';
import { Sync } from '../data/sync';
import { TeamStore } from '../data/team-store';
import { TreeStore } from '../data/tree-store';
import { RealtimeService } from './realtime';

/**
 * Ties the local database and background sync to the signed-in user: opens this user's database
 * and starts syncing when they are signed in, and stops (keeping the data) when they are not.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly auth = inject(AuthStore);
  private readonly db = inject(Db);
  private readonly sync = inject(Sync);
  private readonly media = inject(MediaStore);
  private readonly rt = inject(RealtimeService);
  private readonly teams = inject(TeamStore);
  private readonly tree = inject(TreeStore);

  constructor() {
    // The spaces the person can see (their own, their teams', their projects'): each one tells us when it changed.
    const held = new Map<string, () => void>();
    effect(() => {
      const want = new Set<string>();
      const own = this.auth.user()?.personalSpaceId;
      if (own) want.add(own);
      for (const t of this.teams.teams() ?? []) want.add(t.spaceId);
      for (const p of this.teams.projects()) want.add(p.spaceId);
      // A notebook somebody shared lives in its owner's space: that room tells when it changed.
      for (const s of this.tree.sharedRows()) want.add(s.spaceId);
      untracked(() => {
        for (const [id, leave] of held) if (!want.has(id)) (leave(), held.delete(id));
        for (const id of want) if (!held.has(id)) held.set(id, this.rt.join('space', id));
      });
    });
    // Changes made elsewhere arrive here as events: pull at once instead of waiting for the timer.
    this.rt.on('space.changed').subscribe(() => void this.sync.run());
    this.rt.on<{ teamId?: string }>('permissions.changed').subscribe(() => void this.teams.refreshAll().then(() => this.sync.run()));
    this.rt.resumed.subscribe(() => void this.sync.run());
    // The server ended this login (signed out on another device, password changed).
    this.rt.on('session.revoked').subscribe(() => this.auth.endSession());

    effect(() => {
      const status = this.auth.status();
      const userId = this.auth.userId();
      untracked(() => {
        if (status === 'authed' && userId) {
          this.db.open(userId);
          this.sync.start();
        } else if (status === 'anon') {
          this.sync.stop();
          this.db.close();
          this.media.forgetUrls();
        }
      });
    });
  }

  /** Explicit sign-out: also removes the notes stored on this device. */
  async signOut(): Promise<void> {
    this.sync.stop();
    await this.db.wipe();
    this.media.forgetUrls();
    try {
      // unsaved editor drafts are notes too
      for (const key of Object.keys(localStorage)) if (key.startsWith('os_planner.draft.')) localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    await this.auth.logout();
  }
}
