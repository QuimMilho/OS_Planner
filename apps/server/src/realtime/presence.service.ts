import { Injectable } from '@nestjs/common';
import {
  IDLE_AFTER_MS,
  PRESENCE_THROTTLE_MS,
  SERVER_EVENTS,
  type PresenceStatus,
  type PresenceUpdate,
} from '@os-planner/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeServer, teamRoom, userRoom, type RtRemoteSocket } from './realtime.server.js';

interface Announced {
  /** The status the teams were last told. */
  sent: PresenceStatus;
  /** When (ms). */
  at: number;
  /** A pending announcement of the final state, set while the throttle pause is running. */
  timer?: NodeJS.Timeout;
}

/**
 * Who is online. Nothing is stored: a person is online while at least one of their sockets (on any server instance)
 * was active in the last five minutes, idle while they have sockets but none was, and offline otherwise. Invisible
 * people always read as offline to everyone else.
 *
 * Changes are announced to the room of every team the person belongs to (`team:<id>`), at most one announcement per
 * person every five seconds: a burst of changes (a tab reloading) collapses into its final state.
 */
@Injectable()
export class PresenceService {
  /** What this instance last announced for each person, to skip repeats and to throttle. */
  private readonly announced = new Map<string, Announced>();
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly rt: RealtimeServer,
    private readonly prisma: PrismaService,
  ) {}

  /** The status of a person as other people see it, from their sockets on every instance. */
  statusOf(
    sockets: readonly RtRemoteSocket[],
    invisible: boolean,
    now = Date.now(),
  ): PresenceStatus {
    if (!sockets.length || invisible) return 'offline';
    return sockets.some((s) => now - s.data.lastActivity < IDLE_AFTER_MS) ? 'online' : 'idle';
  }

  private async isInvisible(userId: string): Promise<boolean> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { presenceMode: true },
    });
    return row?.presenceMode === 'invisible';
  }

  /**
   * Works out the person's status and announces it when it changed (throttled). Call after anything that could change it.
   * `now` is the moment the status is judged at (tests move it forward to pass the idle limit); the throttle uses the real clock.
   */
  async refresh(userId: string, now = Date.now()): Promise<void> {
    const clock = Date.now();
    if (!this.rt.started) return;
    const [sockets, invisible] = await Promise.all([
      this.rt.socketsIn(userRoom(userId)),
      this.isInvisible(userId),
    ]);
    const status = this.statusOf(sockets, invisible, now);
    if (status === 'offline') this.lastSeen.set(userId, now);

    const entry = this.announced.get(userId);
    if (status === (entry?.sent ?? 'offline')) {
      // Back to what the teams already know (a quick reconnect): nothing to say, and any pending announcement is moot.
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry) entry.timer = undefined;
      if (entry && status === 'offline') this.announced.delete(userId);
      return;
    }

    const current = entry ?? { sent: 'offline' as PresenceStatus, at: 0 };
    this.announced.set(userId, current);
    const wait = current.at + PRESENCE_THROTTLE_MS - clock;
    if (wait <= 0) {
      if (current.timer) clearTimeout(current.timer);
      current.timer = undefined;
      current.sent = status;
      current.at = clock;
      await this.announce(userId, status, now);
    } else if (!current.timer) {
      // Too soon after the last one: announce whatever the state is when the pause is over.
      current.timer = setTimeout(() => {
        current.timer = undefined;
        void this.refresh(userId);
      }, wait);
      current.timer.unref();
    }
  }

  private async announce(userId: string, status: PresenceStatus, now: number): Promise<void> {
    const teams = await this.prisma.teamMember.findMany({
      where: { userId, team: { deletedAt: null } },
      select: { teamId: true },
    });
    if (!teams.length) return;
    const update: PresenceUpdate = {
      userId,
      status,
      lastSeen:
        status === 'online' ? null : new Date(this.lastSeen.get(userId) ?? now).toISOString(),
    };
    this.rt.emit(
      teams.map((t) => teamRoom(t.teamId)),
      SERVER_EVENTS.presenceUpdate,
      update,
    );
  }

  /** Everyone of the team who is online or idle right now (invisible people left out). */
  async teamSnapshot(teamId: string, now = Date.now()): Promise<PresenceUpdate[]> {
    const sockets = await this.rt.socketsIn(teamRoom(teamId));
    const byUser = new Map<string, RtRemoteSocket[]>();
    for (const s of sockets)
      (byUser.get(s.data.userId) ?? byUser.set(s.data.userId, []).get(s.data.userId)!).push(s);
    if (!byUser.size) return [];
    const hidden = new Set(
      (
        await this.prisma.user.findMany({
          where: { id: { in: [...byUser.keys()] }, presenceMode: 'invisible' },
          select: { id: true },
        })
      ).map((u) => u.id),
    );
    const out: PresenceUpdate[] = [];
    for (const [userId, list] of byUser) {
      const status = this.statusOf(list, hidden.has(userId), now);
      if (status !== 'offline')
        out.push({
          userId,
          status,
          lastSeen:
            status === 'online'
              ? null
              : new Date(Math.max(...list.map((s) => s.data.lastActivity))).toISOString(),
        });
    }
    return out;
  }
}
