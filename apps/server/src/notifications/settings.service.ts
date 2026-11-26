import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  type EffectiveSettingDto,
  type MuteInput,
  type NotificationSettingDto,
  type PutSettingInput,
  type QuietHoursDto,
  type ScopeKind,
} from '@os-planner/shared';
import {
  MUTED_FOREVER,
  NOTIFY_EVENTS,
  NOTIFY_LIMITS,
  quietHoursSchema,
  resolveSetting,
  type Effective,
  type ScopeRule,
} from '@os-planner/shared/chat';
import { newId } from '../common/crypto.js';
import { EventBus } from '../events/event-bus.js';
import type { Channel, NotificationSetting } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { chainIdsOf, PermissionService } from '../spaces/permission.service.js';

/** One place in the chain of scopes a message sits in. */
export interface ScopeRef {
  scopeKind: ScopeKind;
  scopeId: string | null;
}
export const GLOBAL: ScopeRef = { scopeKind: 'global', scopeId: null };
const key = (s: ScopeRef): string => `${s.scopeKind}:${s.scopeId ?? ''}`;

export const toRule = (row: NotificationSetting): ScopeRule => ({
  scopeKind: row.scopeKind as ScopeKind,
  scopeId: row.scopeKind === 'global' ? null : row.scopeId,
  level: row.level as ScopeRule['level'],
  suppressEveryone: row.suppressEveryone,
  suppressRoles: row.suppressRoles,
  suppressDirect: row.suppressDirect,
  mutedUntil: row.mutedUntil ? row.mutedUntil.getTime() : null,
  email: row.email as ScopeRule['email'],
  emailOnlyWhenAway: row.emailOnlyWhenAway,
  push: row.push,
});

const toDto = (row: NotificationSetting): NotificationSettingDto => ({
  id: row.id,
  scopeKind: row.scopeKind as ScopeKind,
  scopeId: row.scopeKind === 'global' ? null : row.scopeId,
  level: row.level as NotificationSettingDto['level'],
  suppressEveryone: row.suppressEveryone,
  suppressRoles: row.suppressRoles,
  suppressDirect: row.suppressDirect,
  mutedUntil: row.mutedUntil?.toISOString() ?? null,
  email: row.email as NotificationSettingDto['email'],
  emailOnlyWhenAway: row.emailOnlyWhenAway,
  push: row.push,
  updatedAt: row.updatedAt.toISOString(),
});

/** The built-in level when nothing is set: conversations notify for everything, channels for mentions. */
export const defaultsFor = (scopeKind: ScopeKind): { level: 'all' | 'mentions' } => ({
  level: scopeKind === 'dm' ? 'all' : 'mentions',
});

/**
 * What a person wants, scope by scope (global, team, project, channel, conversation), and the answer to "what is in effect
 * here". The combining rules are the pure functions in `@os-planner/shared`; this class reads and writes the rows and knows
 * which scopes a place belongs to.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly bus: EventBus,
  ) {}

  // ---------------------------------------------------------------- the chain a place sits in

  /** Nearest first: the channel, the projects above it, the team, then the person's global settings. */
  async chainForChannel(channel: Pick<Channel, 'id' | 'spaceId'>): Promise<ScopeRef[]> {
    const chain: ScopeRef[] = [{ scopeKind: 'channel', scopeId: channel.id }];
    chain.push(...(await this.containerChain(channel.spaceId)));
    return [...chain, GLOBAL];
  }

  private async containerChain(spaceId: string | null): Promise<ScopeRef[]> {
    if (!spaceId) return [];
    const space = await this.prisma.space.findUnique({ where: { id: spaceId } });
    if (!space) return [];
    if (space.kind === 'team' && space.teamId)
      return [{ scopeKind: 'team', scopeId: space.teamId }];
    if (space.kind === 'project' && space.projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: space.projectId } });
      if (!project) return [];
      const projects = chainIdsOf(project.path).reverse(); // nearest first
      return [
        ...projects.map((id): ScopeRef => ({ scopeKind: 'project', scopeId: id })),
        { scopeKind: 'team', scopeId: project.teamId },
      ];
    }
    return [];
  }

  /** The chain of any scope. A conversation has just itself; everything inside a team or project goes up to the team. */
  async chainOf(kind: ScopeKind, id: string | null): Promise<ScopeRef[]> {
    if (kind === 'global' || !id) return [GLOBAL];
    if (kind === 'dm') return [{ scopeKind: 'dm', scopeId: id }, GLOBAL];
    if (kind === 'team') return [{ scopeKind: 'team', scopeId: id }, GLOBAL];
    if (kind === 'project') {
      const project = await this.prisma.project.findUnique({ where: { id } });
      if (!project) return [{ scopeKind: 'project', scopeId: id }, GLOBAL];
      return [
        ...chainIdsOf(project.path)
          .reverse()
          .map((p): ScopeRef => ({ scopeKind: 'project', scopeId: p })),
        { scopeKind: 'team', scopeId: project.teamId },
        GLOBAL,
      ];
    }
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      select: { id: true, spaceId: true },
    });
    return channel
      ? this.chainForChannel(channel)
      : [{ scopeKind: 'channel', scopeId: id }, GLOBAL];
  }

  // ---------------------------------------------------------------- reading rules

  /** Each person's rules for the scopes of `chain`, in the order of the chain (a scope they never set is simply absent). */
  async rulesFor(
    userIds: readonly string[],
    chain: readonly ScopeRef[],
  ): Promise<Map<string, ScopeRule[]>> {
    const out = new Map<string, ScopeRule[]>();
    if (!userIds.length) return out;
    const rows = await this.prisma.notificationSetting.findMany({
      where: {
        userId: { in: [...userIds] },
        OR: chain.map((s) => ({ scopeKind: s.scopeKind, scopeId: s.scopeId ?? '' })),
      },
    });
    const order = new Map(chain.map((s, i) => [key(s), i]));
    const byUser = new Map<string, NotificationSetting[]>();
    for (const r of rows) (byUser.get(r.userId) ?? byUser.set(r.userId, []).get(r.userId)!).push(r);
    for (const [userId, list] of byUser)
      out.set(
        userId,
        list
          .sort(
            (a, b) =>
              order.get(key({ scopeKind: a.scopeKind as ScopeKind, scopeId: a.scopeId }))! -
              order.get(key({ scopeKind: b.scopeKind as ScopeKind, scopeId: b.scopeId }))!,
          )
          .map(toRule),
      );
    return out;
  }

  async effectiveRules(
    userId: string,
    chain: readonly ScopeRef[],
    now = Date.now(),
  ): Promise<Effective> {
    const rules = (await this.rulesFor([userId], chain)).get(userId) ?? [];
    return resolveSetting(rules, now, defaultsFor(chain[0]?.scopeKind ?? 'global'));
  }

  async effective(
    userId: string,
    kind: ScopeKind,
    id: string | null,
  ): Promise<EffectiveSettingDto> {
    await this.assertScope(userId, kind, id);
    const e = await this.effectiveRules(userId, await this.chainOf(kind, id));
    return {
      level: e.level,
      muted: e.muted,
      mutedUntil: e.muted && e.mutedUntil ? new Date(e.mutedUntil).toISOString() : null,
      suppressEveryone: e.suppressEveryone,
      suppressRoles: e.suppressRoles,
      suppressDirect: e.suppressDirect,
      email: e.email,
      emailOnlyWhenAway: e.emailOnlyWhenAway,
      push: e.push,
      sources: e.sources,
    };
  }

  // ---------------------------------------------------------------- who may have a setting for what

  /** The person can see the place a setting is about. Otherwise 404, as for the place itself. */
  async assertScope(userId: string, kind: ScopeKind, id: string | null): Promise<void> {
    if (kind === 'global') return;
    if (!id) throw new NotFoundException();
    let ok = false;
    if (kind === 'team') ok = (await this.perms.teamAccess(userId, id)) !== null;
    else if (kind === 'project') ok = (await this.perms.projectAccess(userId, id)) !== null;
    else if (kind === 'channel') ok = (await this.perms.channelAccess(userId, id)) !== null;
    else {
      const dm = await this.prisma.directConversation.findUnique({
        where: { id },
        select: { userA: true, userB: true },
      });
      ok = dm !== null && (dm.userA === userId || dm.userB === userId);
    }
    if (!ok) throw new NotFoundException();
  }

  // ---------------------------------------------------------------- the person's own rows

  async list(userId: string): Promise<NotificationSettingDto[]> {
    const rows = await this.prisma.notificationSetting.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: NOTIFY_LIMITS.settingsMax,
    });
    return rows.map(toDto);
  }

  private async changed(userId: string): Promise<void> {
    await this.bus.publish('room.event', {
      rooms: [`user:${userId}`],
      name: NOTIFY_EVENTS.settingsChanged,
      payload: {},
    });
  }

  /** Sets what is given and leaves the rest of the row as it was. A row that ends up saying nothing is removed. */
  async put(userId: string, input: PutSettingInput): Promise<NotificationSettingDto | null> {
    await this.assertScope(userId, input.scopeKind, input.scopeId ?? null);
    if (
      input.scopeKind === 'global' &&
      input.suppressDirect !== undefined &&
      input.suppressDirect !== null
    )
      throw new UnprocessableEntityException('suppress_direct_not_global'); // a direct mention is the last thing to be silenced
    const scopeId = input.scopeKind === 'global' ? '' : input.scopeId!;
    const where = { userId_scopeKind_scopeId: { userId, scopeKind: input.scopeKind, scopeId } };
    const data = {
      ...(input.level !== undefined && { level: input.level }),
      ...(input.suppressEveryone !== undefined && { suppressEveryone: input.suppressEveryone }),
      ...(input.suppressRoles !== undefined && { suppressRoles: input.suppressRoles }),
      ...(input.suppressDirect !== undefined && { suppressDirect: input.suppressDirect }),
      ...(input.mutedUntil !== undefined && {
        mutedUntil: input.mutedUntil ? new Date(input.mutedUntil) : null,
      }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.emailOnlyWhenAway !== undefined && { emailOnlyWhenAway: input.emailOnlyWhenAway }),
      ...(input.push !== undefined && { push: input.push }),
    };
    const existing = await this.prisma.notificationSetting.findUnique({ where });
    if (
      !existing &&
      (await this.prisma.notificationSetting.count({ where: { userId } })) >=
        NOTIFY_LIMITS.settingsMax
    )
      throw new UnprocessableEntityException('settings_limit_reached');
    const row = await this.prisma.notificationSetting.upsert({
      where,
      create: { id: newId(), userId, scopeKind: input.scopeKind, scopeId, ...data },
      update: data,
    });
    const empty =
      row.level === 'inherit' &&
      row.email === 'inherit' &&
      row.suppressEveryone === null &&
      row.suppressRoles === null &&
      row.suppressDirect === null &&
      row.mutedUntil === null &&
      row.emailOnlyWhenAway === null &&
      row.push === null;
    if (empty) await this.prisma.notificationSetting.delete({ where: { id: row.id } });
    await this.changed(userId);
    return empty ? null : toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.prisma.notificationSetting.deleteMany({ where: { id, userId } });
    if (!res.count) throw new NotFoundException();
    await this.changed(userId);
  }

  /**
   * Mutes a place until a time in the future. Turning a mute off clears it, unless a place above it is muted: then the
   * place gets an end that has already passed, which is what makes it speak again inside a muted team.
   */
  async mute(userId: string, input: MuteInput): Promise<NotificationSettingDto | null> {
    const until = input.until ? new Date(input.until) : null;
    if (until && until.getTime() <= Date.now())
      throw new UnprocessableEntityException('mute_in_the_past');
    if (until)
      return this.put(userId, {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        mutedUntil: until.toISOString(),
      });
    await this.assertScope(userId, input.scopeKind, input.scopeId ?? null);
    const chain = await this.chainOf(input.scopeKind, input.scopeId ?? null);
    const above = await this.effectiveRules(userId, chain.slice(1));
    return this.put(userId, {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      mutedUntil: above.muted ? new Date(Date.now() - 1000).toISOString() : null,
    });
  }

  /** Used by the unsubscribe link in an email: switches one thing off for one place and nothing else. */
  async setFromMail(
    userId: string,
    scope: ScopeRef,
    action: 'unsubscribe' | 'mute',
  ): Promise<void> {
    const scopeId = scope.scopeKind === 'global' ? '' : (scope.scopeId ?? '');
    const data =
      action === 'unsubscribe' ? { email: 'off' } : { mutedUntil: new Date(MUTED_FOREVER) };
    await this.prisma.notificationSetting.upsert({
      where: { userId_scopeKind_scopeId: { userId, scopeKind: scope.scopeKind, scopeId } },
      create: { id: newId(), userId, scopeKind: scope.scopeKind, scopeId, ...data },
      update: data,
    });
    await this.changed(userId);
  }

  // ---------------------------------------------------------------- quiet hours

  async quietHours(userId: string): Promise<QuietHoursDto | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { quietHours: true },
    });
    const parsed = quietHoursSchema.safeParse(row?.quietHours);
    return parsed.success ? parsed.data : null;
  }

  async setQuietHours(userId: string, value: QuietHoursDto | null): Promise<QuietHoursDto | null> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { quietHours: value ?? undefined },
    });
    if (value === null)
      await this.prisma.$executeRaw`UPDATE \`User\` SET quietHours = NULL WHERE id = ${userId}`;
    await this.changed(userId);
    return value;
  }
}
