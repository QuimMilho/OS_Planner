import { Injectable, effect, inject, untracked } from '@angular/core';
import { AuthStore } from './auth-store';
import { Db } from '../data/db';
import { MediaStore } from '../data/media-store';
import { Sync } from '../data/sync';

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

  constructor() {
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
      for (const key of Object.keys(localStorage)) if (key.startsWith('notes.draft.')) localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
    await this.auth.logout();
  }
}
