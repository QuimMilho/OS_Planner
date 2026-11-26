import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  SERVER_EVENTS,
  type PermissionsChanged,
  type SessionRevoked,
  type SpaceChanged,
} from '@os-planner/shared';
import { EventBus, type DomainEventMap } from '../events/event-bus.js';
import { PresenceService } from './presence.service.js';
import { parseRoom, RoomAuthorizer } from './room-authorizer.js';
import { RealtimeServer, teamRoom, userRoom, type RtRemoteSocket } from './realtime.server.js';

/** Audit actions after which what a person may see or do may have changed. The rest (invites, names, quotas) cannot. */
const AFFECTS_ACCESS = new Set([
  'role.create',
  'role.update',
  'role.delete',
  'role.reorder',
  'role.assign',
  'role.unassign',
  'overwrite.set',
  'overwrite.clear',
  'member.add',
  'member.remove',
  'member.ban',
  'member.unban',
  'request.approve',
  'project.create',
  'project.move',
  'project.delete',
  'project.member.add',
  'project.member.remove',
  'team.create',
  'team.delete',
  'team.owner.transfer',
]);

/**
 * Turns what services announce on the EventBus into what clients hear, and keeps rooms honest:
 *
 *  - an event about a room goes to that room and nobody else;
 *  - when roles, overwrites or membership change, everyone concerned is told (`permissions.changed`) and every room
 *    their connections are in is checked again. A connection that may no longer be in a room is removed from it
 *    before the request that caused the change answers, so nothing published afterwards reaches it;
 *  - a login that ends loses its connections.
 */
@Injectable()
export class RealtimeBridge implements OnApplicationBootstrap {
  private readonly log = new Logger(RealtimeBridge.name);

  constructor(
    private readonly bus: EventBus,
    private readonly rt: RealtimeServer,
    private readonly rooms: RoomAuthorizer,
    private readonly presence: PresenceService,
  ) {}

  onApplicationBootstrap(): void {
    this.bus.subscribe('team.audited', (e) => this.onAudited(e));
    this.bus.subscribe('permissions.changed', (e) => this.recheck(e.userIds, e.teamId));
    this.bus.subscribe('membership.changed', (e) => this.recheck([e.userId]));
    this.bus.subscribe('space.changed', (e) => {
      this.rt.emit(`space:${e.spaceId}`, SERVER_EVENTS.spaceChanged, {
        spaceId: e.spaceId,
        seq: e.seq,
      } satisfies SpaceChanged);
    });
    this.bus.subscribe('room.event', (e) => this.rt.emit(e.rooms, e.name, e.payload, e.except));
    this.bus.subscribe('session.revoked', (e) => this.endSession(e));
    this.bus.subscribe('presence.mode', (e) => this.presence.refresh(e.userId));
  }

  // ---------------------------------------------------------------- permission changes

  private async onAudited(e: DomainEventMap['team.audited']): Promise<void> {
    if (!this.rt.started || !AFFECTS_ACCESS.has(e.action)) return;
    // The person the entry is about may not be in the team's room yet (joining) or any more (leaving, banned).
    const extra: string[] = [];
    if (e.targetKind === 'member') extra.push(e.targetId);
    const owner = (e.after as { ownerId?: unknown } | null)?.ownerId;
    if (typeof owner === 'string') extra.push(owner);
    await this.recheck(extra, e.teamId);
  }

  /**
   * Re-checks the rooms of every connection of `userIds` plus every connection in the team's room (when given), and
   * tells those people to refresh what they may do.
   */
  async recheck(userIds: readonly string[], teamId?: string): Promise<void> {
    if (!this.rt.started) return;
    const sockets = new Map<string, RtRemoteSocket>();
    const lists = await Promise.all(
      [...userIds.map((id) => userRoom(id)), ...(teamId ? [teamRoom(teamId)] : [])].map((room) =>
        this.rt.socketsIn(room),
      ),
    );
    for (const s of lists.flat()) sockets.set(s.id, s);

    const byUser = new Map<string, RtRemoteSocket[]>();
    for (const s of sockets.values())
      (byUser.get(s.data.userId) ?? byUser.set(s.data.userId, []).get(s.data.userId)!).push(s);

    for (const [userId, list] of byUser) {
      const teams = new Set(await this.rooms.teamIds(userId));
      for (const socket of list) await this.reevaluate(socket, userId, teams);
      this.rt.emit(
        userRoom(userId),
        SERVER_EVENTS.permissionsChanged,
        (teamId ? { teamId } : {}) satisfies PermissionsChanged,
      );
    }
  }

  /** Removes the connection from rooms it may no longer be in and puts it in the team rooms it should be in. */
  private async reevaluate(
    socket: RtRemoteSocket,
    userId: string,
    teams: ReadonlySet<string>,
  ): Promise<void> {
    const wantTeamRooms = new Set([...teams].map((id) => teamRoom(id)));
    for (const room of [...socket.rooms]) {
      if (room === socket.id) continue;
      const parsed = parseRoom(room);
      if (!parsed || parsed.kind === 'user') continue;
      const keep =
        parsed.kind === 'team'
          ? wantTeamRooms.has(room)
          : await this.rooms.canJoin(userId, parsed.kind, parsed.id);
      if (!keep) await socket.leave(room);
    }
    for (const room of wantTeamRooms) if (!socket.rooms.has(room)) await socket.join(room);
  }

  // ---------------------------------------------------------------- sessions

  private async endSession(e: DomainEventMap['session.revoked']): Promise<void> {
    if (!this.rt.started) return;
    const reason: SessionRevoked['reason'] = e.reason;
    for (const socket of await this.rt.socketsIn(userRoom(e.userId))) {
      if (e.sessionId && socket.data.sessionId !== e.sessionId) continue;
      if (e.exceptSessionId && socket.data.sessionId === e.exceptSessionId) continue;
      socket.emit(SERVER_EVENTS.sessionRevoked, { reason } satisfies SessionRevoked);
      socket.disconnect(true);
    }
    this.log.debug(`closed the connections of a revoked session of ${e.userId}`);
  }
}
