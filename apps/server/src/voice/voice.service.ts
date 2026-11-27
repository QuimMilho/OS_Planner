import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  Permission,
  checkModeration,
  collabColor,
  hasPermission,
  publishSources,
  voiceGrants,
  type ModerationAction,
  type ModerationParty,
  type VoiceChannelStateDto,
  type VoiceGrants,
  type VoiceModeratedEvent,
  type VoiceParticipantDto,
  type VoiceTokenDto,
} from '@os-planner/shared';
import { VOICE_BITRATE, VOICE_EVENTS, VOICE_LIMITS, type VoiceQuality } from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';
import { ChannelsService } from '../chat/channels.service.js';
import { EventBus } from '../events/event-bus.js';
import type { Channel, VoiceParticipant } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../roles/audit.service.js';
import { PermissionService, type ChannelAccess } from '../spaces/permission.service.js';
import { LiveKitService, type LiveKitEvent } from './livekit.service.js';

const MIC = 1;
const CAM = 2;
const SCREEN = 4;
/** A webhook older than this is a replay (or was stuck somewhere) and is ignored. */
const WEBHOOK_MAX_AGE_MS = 10 * 60 * 1000;
/** A person told to move leaves the old room themselves; this is how long the server waits before it does it for them. */
const MOVE_GRACE_MS = 8000;
const REMEMBER = 2000;

const bitsOf = (g: VoiceGrants, muted: boolean): number =>
  (g.speak && !muted ? MIC : 0) | (g.video ? CAM : 0) | (g.screen ? SCREEN : 0);

const sourcesOf = (bits: number) =>
  publishSources({
    connect: true,
    speak: (bits & MIC) !== 0,
    video: (bits & CAM) !== 0,
    screen: (bits & SCREEN) !== 0,
  });

/** A small set that forgets its oldest entries: ids of webhooks already handled, connections that already ended. */
class Recent {
  private readonly set = new Set<string>();
  has(v: string): boolean {
    return this.set.has(v);
  }
  add(v: string): void {
    this.set.add(v);
    if (this.set.size > REMEMBER) this.set.delete(this.set.values().next().value as string);
  }
}

export class VoiceDenied extends ForbiddenException {}

/**
 * Voice and video channels. The media server (LiveKit) carries the audio and video; this class decides who may be there:
 *  - `token`: a 10-minute access token per join, whose grants are the person's effective permissions in the channel;
 *  - the webhook projection: who is in which channel, kept in `VoiceParticipant` and announced to the channel's room;
 *  - moderation (mute, unmute, move, disconnect), always checked against the hierarchy and written to the audit log;
 *  - enforcement: when roles, overwrites or membership change, whoever may no longer be there is removed within moments.
 * LiveKit is never asked whether somebody may join.
 */
@Injectable()
export class VoiceService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(VoiceService.name);
  private readonly handled = new Recent();
  private readonly ended = new Recent();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private sweep?: NodeJS.Timeout;
  private busy: Promise<void> | null = null;
  private again = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly channels: ChannelsService,
    private readonly livekit: LiveKitService,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get enabled(): boolean {
    return this.livekit.enabled;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    for (const event of ['permissions.changed', 'membership.changed', 'team.audited'] as const) {
      this.unsubscribe.push(this.bus.subscribe(event, () => this.enforce()));
    }
    this.unsubscribe.push(
      this.bus.subscribe('channel.changed', async ({ channelId, deleted }) => {
        if (deleted) await this.livekit.deleteRoom(channelId).catch(() => undefined);
        else await this.enforce();
      }),
    );
    if (this.env.VOICE_CHECK_SECONDS > 0) {
      this.sweep = setInterval(
        () => void this.enforce().then(() => this.reconcile()),
        this.env.VOICE_CHECK_SECONDS * 1000,
      );
      this.sweep.unref();
    }
  }

  /** After a restart (or a media server that was down) the projection is checked against the media server. */
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const t = setTimeout(() => void this.reconcile(), 1500);
    t.unref();
    this.timers.add(t);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    for (const off of this.unsubscribe.splice(0)) off();
    clearInterval(this.sweep);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------------------------------------------------------- reading

  private require(): void {
    if (!this.enabled) throw new NotFoundException('voice_unavailable');
  }

  /** The voice channel if the person can see it, else 404 (a text channel or a category is not one). */
  private async voiceChannel(userId: string, channelId: string): Promise<ChannelAccess> {
    this.require();
    const access = await this.channels.access(userId, channelId);
    if (access.channel.kind !== 'voice') throw new NotFoundException();
    return access;
  }

  private async teamIdOf(channel: Pick<Channel, 'spaceId'>): Promise<string | null> {
    if (!channel.spaceId) return null;
    const space = await this.prisma.space.findUnique({
      where: { id: channel.spaceId },
      select: { teamId: true, project: { select: { teamId: true } } },
    });
    return space?.teamId ?? space?.project?.teamId ?? null;
  }

  private async participantDtos(
    teamId: string | null,
    rows: VoiceParticipant[],
  ): Promise<VoiceParticipantDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.userId);
    const [users, members] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true },
      }),
      teamId
        ? this.prisma.teamMember.findMany({
            where: { teamId, userId: { in: ids } },
            select: { userId: true, nickname: true },
          })
        : [],
    ]);
    const nick = new Map(members.map((m) => [m.userId, m.nickname]));
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    return rows
      .slice()
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || (a.userId < b.userId ? -1 : 1))
      .map((r) => ({
        userId: r.userId,
        name: nick.get(r.userId) || name.get(r.userId) || '?',
        color: collabColor(r.userId),
        joinedAt: r.joinedAt.toISOString(),
        mutedByModerator: r.mutedByModerator,
      }));
  }

  private async nameOf(teamId: string | null, userId: string): Promise<string> {
    const [user, member] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
      teamId
        ? this.prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId, userId } },
            select: { nickname: true },
          })
        : null,
    ]);
    return member?.nickname || user?.displayName || '?';
  }

  /** Who is in one voice channel now. */
  async state(channelId: string): Promise<VoiceChannelStateDto> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    const rows = channel
      ? await this.prisma.voiceParticipant.findMany({ where: { channelId } })
      : [];
    return {
      channelId,
      participants: await this.participantDtos(channel ? await this.teamIdOf(channel) : null, rows),
    };
  }

  async channelState(userId: string, channelId: string): Promise<VoiceChannelStateDto> {
    await this.voiceChannel(userId, channelId);
    return this.state(channelId);
  }

  /** Every voice channel of the team and its projects that the person can see, with who is in it (what the sidebar shows). */
  async teamState(userId: string, teamId: string): Promise<VoiceChannelStateDto[]> {
    this.require();
    const visible = (await this.channels.listTeam(userId, teamId)).filter(
      (c) => c.kind === 'voice',
    );
    if (!visible.length) return [];
    const rows = await this.prisma.voiceParticipant.findMany({
      where: { channelId: { in: visible.map((c) => c.id) } },
    });
    const dtos = await this.participantDtos(teamId, rows);
    const byUser = new Map(dtos.map((d) => [d.userId, d]));
    return visible.map((c) => ({
      channelId: c.id,
      participants: rows
        .filter((r) => r.channelId === c.id)
        .map((r) => byUser.get(r.userId)!)
        .filter(Boolean)
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || (a.userId < b.userId ? -1 : 1)),
    }));
  }

  private async publishState(channelId: string): Promise<void> {
    await this.bus.publish('room.event', {
      rooms: [`channel:${channelId}`],
      name: VOICE_EVENTS.participants,
      payload: await this.state(channelId),
    });
  }

  // ---------------------------------------------------------------- limits

  private channelLimit(channel: Channel): number {
    return channel.userLimit ?? this.env.VOICE_MAX_PARTICIPANTS;
  }

  private async teamLimit(teamId: string): Promise<number> {
    const override = await this.prisma.quotaOverride.findUnique({
      where: { scope_scopeId: { scope: 'team', scopeId: teamId } },
      select: { maxVoiceParticipants: true },
    });
    return override?.maxVoiceParticipants ?? this.env.VOICE_TEAM_MAX_PARTICIPANTS;
  }

  private teamCount(teamId: string): Promise<number> {
    return this.prisma.voiceParticipant.count({
      where: { channel: { space: { OR: [{ teamId }, { project: { teamId } }] } } },
    });
  }

  // ---------------------------------------------------------------- joining

  /**
   * The token to join a voice channel. 404 without VIEW_CHANNEL, 403 without CONNECT, 409 when the channel (or the team's
   * voice allowance) is full. The grants in the token are exactly what the person's permissions in the channel say.
   */
  async token(userId: string, channelId: string): Promise<VoiceTokenDto> {
    const access = await this.voiceChannel(userId, channelId);
    const { channel } = access;
    if (!hasPermission(access.perms, Permission.CONNECT)) throw new ForbiddenException('forbidden');
    if (channel.archivedAt) throw new ConflictException('channel_archived');

    const teamId = access.chat.teamId;
    const present = await this.prisma.voiceParticipant.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (!present) {
      if (
        (await this.prisma.voiceParticipant.count({ where: { channelId } })) >=
        this.channelLimit(channel)
      )
        throw new ConflictException('channel_full');
      if ((await this.teamCount(teamId)) >= (await this.teamLimit(teamId)))
        throw new ConflictException('team_voice_full');
    }

    const muted = present?.mutedByModerator ?? false;
    const grants = voiceGrants(access.perms);
    const name = await this.nameOf(teamId, userId);
    const quality = (channel.quality as VoiceQuality | null) ?? 'normal';
    const { token, expiresAt } = await this.livekit.accessToken({
      room: channelId,
      identity: userId,
      name,
      metadata: JSON.stringify({ color: collabColor(userId) }),
      attributes: muted ? { [VOICE_LIMITS.attributeModMuted]: '1' } : {},
      sources: publishSources(grants, muted),
    });
    return {
      url: this.livekit.publicUrl,
      token,
      expiresAt: expiresAt.toISOString(),
      canSpeak: grants.speak && !muted,
      canVideo: grants.video,
      canShare: grants.screen,
      bitrate: VOICE_BITRATE[quality] ?? VOICE_BITRATE.normal,
      mutedByModerator: muted,
    };
  }

  // ---------------------------------------------------------------- moderation

  private async party(userId: string, access: ChannelAccess): Promise<ModerationParty | null> {
    const team = await this.perms.teamAccess(userId, access.chat.teamId);
    if (!team) return null;
    const chain = access.chat.levels.map((l) => l.id);
    const own = userId === team.team.ownerId;
    return {
      isOwner: own,
      perms: (await this.perms.channelAccess(userId, access.channel.id))?.perms ?? team.perms,
      rank: own ? Number.POSITIVE_INFINITY : this.perms.rankIn(team, chain),
    };
  }

  /** Mute, unmute, move or disconnect a person who is in the voice channel. */
  async moderate(
    actorId: string,
    channelId: string,
    targetId: string,
    action: ModerationAction,
    toChannelId?: string,
  ): Promise<void> {
    const access = await this.voiceChannel(actorId, channelId);
    const teamId = access.chat.teamId;
    const actor = await this.party(actorId, access);
    const target = await this.party(targetId, access);
    if (!actor) throw new NotFoundException();
    const row = await this.prisma.voiceParticipant.findUnique({
      where: { channelId_userId: { channelId, userId: targetId } },
    });
    // who is where is only told to people who may moderate at all
    const denial = target ? checkModeration(actor, action, target, actorId === targetId) : null;
    if (denial === 'missing_permission') throw new VoiceDenied('forbidden');
    if (!row || !target) throw new NotFoundException('not_in_channel');
    if (denial) throw new VoiceDenied(denial);

    let destination: ChannelAccess | null = null;
    if (action === 'move') {
      if (!toChannelId || toChannelId === channelId)
        throw new UnprocessableEntityException('invalid_destination');
      destination = await this.channels.access(actorId, toChannelId);
      if (destination.channel.kind !== 'voice' || destination.chat.teamId !== teamId)
        throw new UnprocessableEntityException('invalid_destination');
      if (!hasPermission(destination.perms, Permission.MOVE_MEMBERS) && !actor.isOwner)
        throw new VoiceDenied('forbidden');
      const there = await this.perms.channelAccess(targetId, toChannelId);
      if (
        !there ||
        !hasPermission(there.perms, Permission.CONNECT) ||
        destination.channel.archivedAt
      )
        throw new UnprocessableEntityException('cannot_join_destination');
      if (
        (await this.prisma.voiceParticipant.count({ where: { channelId: toChannelId } })) >=
        this.channelLimit(destination.channel)
      )
        throw new ConflictException('channel_full');
    }

    const grants = voiceGrants(target.perms);
    if (action === 'mute') {
      await this.livekit.updateParticipant(channelId, targetId, publishSources(grants, true), {
        [VOICE_LIMITS.attributeModMuted]: '1',
      });
      await this.livekit.muteTracks(channelId, targetId, 'MICROPHONE', true).catch(() => undefined);
    } else if (action === 'unmute') {
      await this.livekit.updateParticipant(channelId, targetId, publishSources(grants, false), {
        [VOICE_LIMITS.attributeModMuted]: '',
      });
    } else if (action === 'disconnect') {
      await this.livekit.removeParticipant(channelId, targetId);
    }

    await this.prisma.$transaction(async (tx) => {
      if (action === 'mute' || action === 'unmute') {
        const muted = action === 'mute';
        await tx.voiceParticipant.updateMany({
          where: { channelId, userId: targetId },
          data: { mutedByModerator: muted, grants: bitsOf(grants, muted) },
        });
      } else if (action === 'disconnect') {
        await tx.voiceParticipant.deleteMany({
          where: { channelId, userId: targetId, sid: row.sid },
        });
      }
      await this.audit.record(tx, {
        teamId,
        actorId,
        action: `voice.${action}`,
        targetKind: 'user',
        targetId,
        after: { channelId, ...(toChannelId ? { toChannelId } : {}) },
      });
    });

    const by = await this.nameOf(teamId, actorId);
    const event: VoiceModeratedEvent = {
      action,
      channelId,
      toChannelId: toChannelId ?? null,
      byUserId: actorId,
      byName: by,
    };
    await this.bus.publish('room.event', {
      rooms: [`user:${targetId}`],
      name: VOICE_EVENTS.moderated,
      payload: event,
    });
    await this.publishState(channelId);

    if (action === 'move') {
      // The person's own browser reconnects to the other room; if it does not (closed lid), the server takes them out of this one.
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (!this.stopping) void this.removeIfStill(channelId, targetId, row.sid);
      }, MOVE_GRACE_MS);
      t.unref();
      this.timers.add(t);
    }
  }

  private async removeIfStill(channelId: string, userId: string, sid: string): Promise<void> {
    const row = await this.prisma.voiceParticipant.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (row?.sid === sid) await this.expel(row);
  }

  // ---------------------------------------------------------------- the media server tells what happened

  async onWebhook(e: LiveKitEvent): Promise<void> {
    if (e.id && this.handled.has(e.id)) return;
    if (e.id) this.handled.add(e.id);
    const at = Number(e.createdAt) * 1000;
    if (!Number.isFinite(at) || Date.now() - at > WEBHOOK_MAX_AGE_MS) return; // a replay
    const channelId = e.room?.name ?? '';
    const userId = e.participant?.identity ?? '';
    const sid = e.participant?.sid ?? '';

    if (e.event === 'room_finished') {
      if (await this.prisma.voiceParticipant.count({ where: { channelId } })) {
        await this.prisma.voiceParticipant.deleteMany({ where: { channelId } });
        await this.publishState(channelId);
      }
    } else if (e.event === 'participant_left' && userId && sid) {
      const gone = await this.prisma.voiceParticipant.deleteMany({
        where: { channelId, userId, sid },
      });
      if (gone.count) await this.publishState(channelId);
      else this.ended.add(sid); // a "joined" of this connection that arrives late must not bring it back
    } else if (e.event === 'participant_joined' && userId && sid) {
      await this.joined(channelId, userId, sid, at, e.participant?.joinedAt);
    }
  }

  private async joined(
    channelId: string,
    userId: string,
    sid: string,
    at: number,
    joinedAt: number | string | undefined,
  ): Promise<void> {
    if (this.ended.has(sid)) return;
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.kind !== 'voice') {
      await this.livekit.removeParticipant(channelId, userId).catch(() => undefined); // a room this server never made
      return;
    }
    const access = await this.perms.channelAccess(userId, channelId);
    if (!access || !hasPermission(access.perms, Permission.CONNECT) || channel.archivedAt) {
      await this.livekit.removeParticipant(channelId, userId).catch(() => undefined);
      return;
    }
    const existing = await this.prisma.voiceParticipant.findUnique({
      where: { channelId_userId: { channelId, userId } },
    });
    if (existing && (existing.sid === sid || existing.eventAt > BigInt(at))) return;

    const muted = existing?.mutedByModerator ?? false;
    const seconds = Number(joinedAt);
    const joinedDate =
      Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
    const data = {
      sid,
      eventAt: BigInt(at),
      mutedByModerator: muted,
      grants: bitsOf(voiceGrants(access.perms), muted),
    };
    await this.prisma.voiceParticipant.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId, joinedAt: joinedDate, ...data },
      update: data,
    });

    // Whatever the token check let through, the room never holds more than its limits.
    const teamId = access.chat.teamId;
    const inChannel = await this.prisma.voiceParticipant.count({ where: { channelId } });
    if (
      inChannel > this.channelLimit(channel) ||
      (await this.teamCount(teamId)) > (await this.teamLimit(teamId))
    ) {
      await this.prisma.voiceParticipant.deleteMany({ where: { channelId, userId, sid } });
      await this.livekit.removeParticipant(channelId, userId).catch(() => undefined);
    }
    await this.publishState(channelId);
  }

  // ---------------------------------------------------------------- keeping the room honest

  /** Takes a person out of the room; the row goes once the media server confirmed (otherwise the next check tries again). */
  private async expel(row: Pick<VoiceParticipant, 'channelId' | 'userId' | 'sid'>): Promise<void> {
    try {
      await this.livekit.removeParticipant(row.channelId, row.userId);
    } catch (e) {
      this.log.warn(
        `could not remove ${row.userId} from ${row.channelId}: ${e instanceof Error ? e.message : e}`,
      );
      return;
    }
    await this.prisma.voiceParticipant.deleteMany({
      where: { channelId: row.channelId, userId: row.userId, sid: row.sid },
    });
    this.ended.add(row.sid);
    await this.publishState(row.channelId);
    await this.bus.publish('room.event', {
      rooms: [`user:${row.userId}`],
      name: VOICE_EVENTS.moderated,
      payload: {
        action: 'disconnect',
        channelId: row.channelId,
        toChannelId: null,
        byUserId: '',
        byName: '',
      } satisfies VoiceModeratedEvent,
    });
  }

  /**
   * Checks everybody who is in a voice channel against what they may do now: whoever lost CONNECT (or the channel, or the team)
   * is removed, whoever gained or lost SPEAK/VIDEO/SCREEN_SHARE gets the new grants. Runs on every permission event and as a backstop.
   * Overlapping calls are folded into one more pass.
   */
  enforce(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    this.busy = (async () => {
      do {
        this.again = false;
        await this.enforceAll();
      } while (this.again && !this.stopping);
    })()
      .catch((e: unknown) =>
        this.log.warn(`permission check failed: ${e instanceof Error ? e.message : e}`),
      )
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }

  private async enforceAll(): Promise<void> {
    const rows = await this.prisma.voiceParticipant.findMany({ include: { channel: true } });
    for (const row of rows) {
      if (this.stopping) return;
      const access = await this.perms.channelAccess(row.userId, row.channelId);
      if (!access || !hasPermission(access.perms, Permission.CONNECT) || row.channel.archivedAt) {
        await this.expel(row);
        continue;
      }
      const bits = bitsOf(voiceGrants(access.perms), row.mutedByModerator);
      if (bits === row.grants) continue;
      try {
        await this.livekit.updateParticipant(row.channelId, row.userId, sourcesOf(bits));
        if ((row.grants & MIC) !== 0 && (bits & MIC) === 0)
          await this.livekit
            .muteTracks(row.channelId, row.userId, 'MICROPHONE', true)
            .catch(() => undefined);
        await this.prisma.voiceParticipant.updateMany({
          where: { channelId: row.channelId, userId: row.userId, sid: row.sid },
          data: { grants: bits },
        });
      } catch (e) {
        this.log.warn(
          `could not update ${row.userId} in ${row.channelId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Compares the projection with the media server: people it no longer has are removed from the list, people it has that no
   * webhook announced (the server was down) are added. Does nothing while the media server cannot be reached.
   */
  async reconcile(): Promise<void> {
    if (!this.enabled || this.stopping) return;
    try {
      const rows = await this.prisma.voiceParticipant.findMany();
      const rooms = new Set(rows.map((r) => r.channelId));
      for (const name of await this.livekit.listRooms()) rooms.add(name);
      for (const channelId of rooms) {
        const mine = rows.filter((r) => r.channelId === channelId);
        const live = await this.livekit.listParticipants(channelId);
        const liveBy = new Map(live.map((p) => [p.identity, p]));
        let changed = false;
        for (const row of mine) {
          if (liveBy.get(row.userId)?.sid === row.sid) continue;
          const gone = await this.prisma.voiceParticipant.deleteMany({
            where: { channelId, userId: row.userId, sid: row.sid },
          });
          changed ||= gone.count > 0;
        }
        for (const p of live) {
          if (mine.some((r) => r.userId === p.identity && r.sid === p.sid)) continue;
          if (
            !(await this.prisma.voiceParticipant.findUnique({
              where: { channelId_userId: { channelId, userId: p.identity } },
            }))
          )
            await this.joined(channelId, p.identity, p.sid, Date.now(), undefined);
        }
        if (changed) await this.publishState(channelId);
      }
    } catch (e) {
      this.log.debug(`reconcile skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
}
