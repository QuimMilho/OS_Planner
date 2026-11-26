import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { PresenceStatus, PresenceUpdate, TeamPresenceDto } from '@os-planner/shared';
import { RealtimeService } from '../core/realtime';

/**
 * Who of the teams the person can see is online or idle right now. Starts from the server's snapshot of a team and
 * then follows `presence.update`; after a reconnect the snapshots are read again, because updates sent while the
 * connection was down are gone.
 */
@Injectable({ providedIn: 'root' })
export class PresenceStore {
  private readonly http = inject(HttpClient);
  private readonly rt = inject(RealtimeService);

  private readonly map = signal<ReadonlyMap<string, PresenceStatus>>(new Map());
  private readonly watched = new Map<string, number>();

  constructor() {
    this.rt.on<PresenceUpdate>('presence.update').subscribe((u) => this.set(u.userId, u.status));
    this.rt.resumed.subscribe(() => void this.reload());
  }

  /** `offline` for anyone not known to be online (and for people who chose to appear offline). */
  statusOf(userId: string): PresenceStatus {
    return this.map().get(userId) ?? 'offline';
  }

  /** Follow a team while a screen shows its members. Returns the function that stops following. */
  watch(teamId: string): () => void {
    this.watched.set(teamId, (this.watched.get(teamId) ?? 0) + 1);
    void this.load(teamId);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.watched.get(teamId) ?? 1) - 1;
      if (n > 0) this.watched.set(teamId, n);
      else this.watched.delete(teamId);
    };
  }

  private set(userId: string, status: PresenceStatus): void {
    this.map.update((m) => {
      const next = new Map(m);
      if (status === 'offline') next.delete(userId);
      else next.set(userId, status);
      return next;
    });
  }

  private async load(teamId: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<TeamPresenceDto>(`/api/teams/${teamId}/presence`),
      );
      this.map.update((m) => {
        const next = new Map(m);
        for (const u of res.online) next.set(u.userId, u.status);
        return next;
      });
    } catch {
      /* offline, or not a member any more: the dots stay as they were */
    }
  }

  private async reload(): Promise<void> {
    await Promise.all([...this.watched.keys()].map((id) => this.load(id)));
  }
}
