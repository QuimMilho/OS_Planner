import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DEFAULT_EVERYONE,
  hasPermission,
  Permission,
  permissionsToString,
  type AdminTeamDto,
  type Locale,
  type CreateTeamInput,
  type JoinPolicy,
  type TeamDto,
  type TeamMeDto,
  type TeamMemberDto,
  type UpdateTeamInput,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import type { Team } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { QuotaExceeded } from '../quota/quota.errors.js';
import { QuotaService } from '../quota/quota.service.js';
import { AuditService } from '../roles/audit.service.js';
import { RoleHierarchy } from '../roles/role-hierarchy.service.js';
import { PermissionService, type TeamAccess } from '../spaces/permission.service.js';

const slugify = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'team';

/** The directory tags of a team (stored as a JSON array, NULL when it has none). */
export const tagsOf = (team: { listingTags: unknown }): string[] =>
  Array.isArray(team.listingTags) ? (team.listingTags as string[]) : [];

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

@Injectable()
export class TeamsService {
  private readonly log = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly hierarchy: RoleHierarchy,
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------- for members

  private toDto(team: Team, userId: string, memberCount: number): TeamDto {
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      icon: team.icon,
      color: team.color,
      description: team.description,
      isPublic: team.isPublic,
      joinPolicy: team.joinPolicy as JoinPolicy,
      listingBlurb: team.listingBlurb,
      listingTags: tagsOf(team),
      allowMemberDMs: team.allowMemberDMs,
      allowPublicLinks: team.allowPublicLinks,
      spaceId: team.spaceId,
      ownerId: team.ownerId,
      isOwner: team.ownerId === userId,
      memberCount,
      createdAt: team.createdAt.toISOString(),
    };
  }

  /** The teams the person belongs to, newest membership last. */
  async list(userId: string): Promise<TeamDto[]> {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId, team: { deletedAt: null } },
      include: { team: { include: { _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'asc' },
    });
    return memberships.map((m) => this.toDto(m.team, userId, m.team._count.members));
  }

  /** 404 for a team the person does not belong to, exactly as if it did not exist. */
  async get(userId: string, teamId: string): Promise<TeamDto> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    return this.toDto(
      access.team,
      userId,
      await this.prisma.teamMember.count({ where: { teamId } }),
    );
  }

  async update(userId: string, teamId: string, patch: UpdateTeamInput): Promise<TeamDto> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (!hasPermission(access.perms, Permission.MANAGE_TEAM))
      throw new ForbiddenException('forbidden');
    const before = access.team;
    const team = await this.prisma.$transaction(async (tx) => {
      const row = await tx.team.update({
        where: { id: teamId },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.icon !== undefined && { icon: patch.icon }),
          ...(patch.color !== undefined && { color: patch.color }),
          ...(patch.isPublic !== undefined && { isPublic: patch.isPublic }),
          ...(patch.joinPolicy !== undefined && { joinPolicy: patch.joinPolicy }),
          ...(patch.listingBlurb !== undefined && { listingBlurb: patch.listingBlurb }),
          ...(patch.listingTags !== undefined && { listingTags: patch.listingTags }),
          ...(patch.allowMemberDMs !== undefined && { allowMemberDMs: patch.allowMemberDMs }),
          ...(patch.allowPublicLinks !== undefined && { allowPublicLinks: patch.allowPublicLinks }),
        },
      });
      const fields = [
        'name',
        'description',
        'icon',
        'color',
        'isPublic',
        'joinPolicy',
        'listingBlurb',
        'listingTags',
        'allowMemberDMs',
        'allowPublicLinks',
      ] as const;
      const changed = fields.filter((f) => !sameValue(before[f], row[f]));
      if (changed.length)
        await this.audit.record(tx, {
          teamId,
          actorId: userId,
          action: 'team.update',
          targetKind: 'team',
          targetId: teamId,
          before: Object.fromEntries(changed.map((f) => [f, before[f]])),
          after: Object.fromEntries(changed.map((f) => [f, row[f]])),
        });
      return row;
    });
    return this.toDto(team, userId, await this.prisma.teamMember.count({ where: { teamId } }));
  }

  /** Any member may see who else is in the team; people outside it get a 404. */
  async members(userId: string, teamId: string): Promise<TeamMemberDto[]> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    const rows = await this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: { displayName: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    const held = await this.prisma.memberRole.findMany({
      where: { role: { teamId, projectId: null } },
      select: { userId: true, roleId: true },
    });
    const rolesOf = new Map<string, string[]>();
    for (const h of held) (rolesOf.get(h.userId) ?? rolesOf.set(h.userId, []).get(h.userId)!).push(h.roleId);
    return rows.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      nickname: m.nickname,
      isOwner: m.userId === access.team.ownerId,
      roleIds: rolesOf.get(m.userId) ?? [],
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  /** People set their own nickname; changing someone else's needs MANAGE_MEMBERS. An empty nickname removes it. */
  async setNickname(userId: string, teamId: string, targetId: string, nickname: string | null): Promise<void> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (targetId !== userId && !hasPermission(access.perms, Permission.MANAGE_MEMBERS))
      throw new ForbiddenException('forbidden');
    const member = await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId: targetId } } });
    if (!member) throw new NotFoundException();
    const next = nickname?.trim() ? nickname.trim() : null;
    if (next === member.nickname) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.update({ where: { teamId_userId: { teamId, userId: targetId } }, data: { nickname: next } });
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'member.nickname',
        targetKind: 'member',
        targetId,
        before: { nickname: member.nickname },
        after: { nickname: next },
      });
    });
  }

  /** What the person may do here and in each project they can see (for the web UI; the server stays authoritative). */
  async me(userId: string, teamId: string): Promise<TeamMeDto> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    const projects: Record<string, string> = {};
    for (const v of await this.perms.visibleProjects(userId, access))
      projects[v.project.id] = permissionsToString(v.perms);
    return {
      teamId,
      isOwner: access.isOwner,
      permissions: permissionsToString(access.perms),
      projects,
      pendingRequests: hasPermission(access.perms, Permission.MANAGE_MEMBERS)
        ? await this.prisma.joinRequest.count({ where: { teamId, pending: 1 } })
        : 0,
    };
  }

  /**
   * Removes a person from a team and, with them, from every project and sub-project of it. The
   * owner cannot be removed (ownership is transferred first). People may remove themselves (leave);
   * removing someone else (kick) needs MANAGE_MEMBERS and a rank above theirs, unless the owner does it.
   */
  async removeMember(userId: string, teamId: string, targetId: string): Promise<void> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (targetId !== userId && !hasPermission(access.perms, Permission.MANAGE_MEMBERS))
      throw new ForbiddenException('forbidden');
    if (targetId === access.team.ownerId)
      throw new UnprocessableEntityException('owner_cannot_leave');
    if (targetId !== userId) await this.assertOutranks(access, targetId);
    await this.prisma.$transaction(async (tx) => {
      const roles = await tx.memberRole.findMany({ where: { userId: targetId, role: { teamId } }, include: { role: true } });
      if ((await tx.teamMember.count({ where: { teamId, userId: targetId } })) === 0) return;
      await this.dropMember(tx, teamId, targetId);
      if (roles.some((r) => r.role.projectId === null && hasPermission(r.role.permissions, Permission.ADMINISTRATOR)))
        await this.hierarchy.assertAdministratorRemains(tx, teamId);
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'member.remove',
        targetKind: 'member',
        targetId,
        before: { roles: roles.map((r) => r.role.name), left: targetId === userId },
      });
    });
  }

  /**
   * Whoever removes or bans somebody must rank strictly above them (the owner, who is above every role, always does).
   * Somebody who is not in the team has no roles: there is nobody to outrank.
   */
  async assertOutranks(actor: TeamAccess, targetId: string): Promise<void> {
    if (actor.isOwner) return;
    const target = await this.perms.teamAccess(targetId, actor.team.id);
    if (!target) return;
    if (target.isOwner || this.perms.rankIn(target) >= this.perms.rankIn(actor)) throw new ForbiddenException('role_at_or_above');
  }

  /** The membership rows, the roles they held and the overwrites that named them; callers check who may do it. */
  async dropMember(tx: Tx, teamId: string, userId: string): Promise<void> {
    await tx.projectMember.deleteMany({ where: { userId, project: { teamId } } });
    await tx.memberRole.deleteMany({ where: { userId, role: { teamId } } });
    const projects = await tx.project.findMany({ where: { teamId }, select: { id: true } });
    if (projects.length)
      await tx.overwrite.deleteMany({
        where: { subjectKind: 'member', subjectId: userId, targetKind: 'project', targetId: { in: projects.map((p) => p.id) } },
      });
    // ...and the ones that named them on a channel or category of the team (or of one of its projects).
    const channels = await tx.channel.findMany({ where: { space: { OR: [{ teamId }, { project: { teamId } }] } }, select: { id: true } });
    if (channels.length)
      await tx.overwrite.deleteMany({
        where: { subjectKind: 'member', subjectId: userId, targetKind: 'channel', targetId: { in: channels.map((c) => c.id) } },
      });
    const notebooks = await tx.notebook.findMany({ where: { space: { OR: [{ teamId }, { project: { teamId } }] } }, select: { id: true } });
    if (notebooks.length)
      await tx.overwrite.deleteMany({
        where: { subjectKind: 'member', subjectId: userId, targetKind: 'notebook', targetId: { in: notebooks.map((n) => n.id) } },
      });
    // Invitations the person made stop working with them: whatever roles they carry were theirs to give.
    await tx.invite.updateMany({
      where: { teamId, invitedBy: userId, revokedAt: null, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.teamMember.deleteMany({ where: { teamId, userId } });
  }

  /**
   * Adds a person to a team, within the team's member limit (413 `quota_exceeded`, scope team). Every way of joining
   * comes through here: the team row is locked first, so joins happen one at a time and the limit holds under load.
   * Returns false when the person was already a member (they do not take a second seat).
   */
  async addMember(tx: Tx, teamId: string, userId: string, enforceLimit = true): Promise<boolean> {
    await tx.$queryRaw`SELECT \`id\` FROM \`Team\` WHERE \`id\` = ${teamId} FOR UPDATE`;
    if ((await tx.teamMember.count({ where: { teamId, userId } })) > 0) return false;
    if (enforceLimit) {
      const limits = await this.quota.limitFor('team', teamId, tx);
      const members = await tx.teamMember.count({ where: { teamId } });
      if (limits.maxMembers > 0 && members >= limits.maxMembers)
        throw new QuotaExceeded('team', limits.maxMembers, members, 1);
    }
    await tx.teamMember.create({ data: { teamId, userId } });
    return true;
  }

  // ---------------------------------------------------------------- ownership promised by email

  /**
   * Makes the person the owner of every team that was created for their email address. Only a
   * *verified* address counts: otherwise registering somebody else's email would hand over a team.
   * Called whenever somebody signs in or verifies their address; it does nothing when there is nothing pending.
   */
  async claimPending(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) return 0;
    const pending = await this.prisma.pendingOwner.findMany({
      where: { email: user.email },
      include: { team: true },
    });
    if (!pending.length) return 0;
    let claimed = 0;
    const named: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const p of pending) {
        if (p.team.deletedAt === null && p.team.ownerId === null) {
          await tx.team.update({ where: { id: p.teamId }, data: { ownerId: userId } });
          await this.addMember(tx, p.teamId, userId, false);
          await this.audit.record(tx, {
            teamId: p.teamId,
            actorId: userId,
            action: 'team.owner.transfer',
            targetKind: 'team',
            targetId: p.teamId,
            before: { ownerId: null },
            after: { ownerId: userId, email: p.email },
          });
          claimed++;
          named.push(p.team.name);
        }
        await tx.pendingOwner.delete({ where: { id: p.id } });
      }
    });
    if (claimed) {
      this.log.log(`${userId} became the owner of ${claimed} team(s) created for their address`);
      const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, locale: true } });
      if (me)
        for (const team of named) await this.mail.sendOwnership(me.email, me.displayName, me.locale as Locale, team, 'assigned');
    }
    return claimed;
  }

  // ---------------------------------------------------------------- instance admin

  private async uniqueSlug(tx: Tx, name: string): Promise<string> {
    const base = slugify(name);
    for (let n = 1; n < 100; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      if (!(await tx.team.findUnique({ where: { slug }, select: { id: true } }))) return slug;
    }
    return `${base}-${newId().slice(0, 8)}`;
  }

  /**
   * Creates a team and its space. The owner is the account with that email when it exists and is
   * verified; otherwise the team waits for them (PendingOwner) and has no members until then.
   */
  async adminCreate(input: CreateTeamInput, adminId: string): Promise<AdminTeamDto> {
    const owner = await this.prisma.user.findUnique({
      where: { email: input.ownerEmail },
      select: { id: true, emailVerifiedAt: true },
    });
    const ownerId = owner?.emailVerifiedAt ? owner.id : null;
    const teamId = newId();
    const spaceId = newId();

    await this.prisma.$transaction(async (tx) => {
      await tx.team.create({
        data: {
          id: teamId,
          name: input.name,
          slug: await this.uniqueSlug(tx, input.name),
          isPublic: input.isPublic,
          joinPolicy: input.joinPolicy,
          spaceId,
          ownerId,
        },
      });
      await tx.role.create({
        data: { id: newId(), teamId, name: '@everyone', position: 0, permissions: DEFAULT_EVERYONE, isEveryone: true },
      });
      await tx.space.create({ data: { id: spaceId, kind: 'team', teamId } });
      await this.audit.record(tx, {
        teamId,
        actorId: adminId,
        action: 'team.create',
        targetKind: 'team',
        targetId: teamId,
        after: { name: input.name, ownerEmail: input.ownerEmail, ownerId, isPublic: input.isPublic, joinPolicy: input.joinPolicy },
      });
      if (ownerId) await tx.teamMember.create({ data: { teamId, userId: ownerId } });
      else await tx.pendingOwner.create({ data: { id: newId(), teamId, email: input.ownerEmail } });
    });
    this.log.log(
      `team ${teamId} created by ${adminId} for ${input.ownerEmail}${ownerId ? '' : ' (pending: no verified account yet)'}`,
    );
    if (!ownerId) {
      // The person has no verified account yet: tell them the team is waiting (in the administrator's language).
      const admin = await this.prisma.user.findUnique({ where: { id: adminId }, select: { locale: true } });
      await this.mail.sendOwnership(input.ownerEmail, null, (admin?.locale ?? 'en') as Locale, input.name, 'offered');
    }
    return this.adminOne(teamId);
  }

  async adminList(): Promise<AdminTeamDto[]> {
    const teams = await this.prisma.team.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return Promise.all(teams.map((t) => this.adminOne(t.id)));
  }

  async adminOne(teamId: string): Promise<AdminTeamDto> {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, deletedAt: null },
      include: {
        owner: { select: { id: true, email: true, displayName: true } },
        pendingOwners: true,
        _count: { select: { members: true, projects: { where: { deletedAt: null } } } },
      },
    });
    if (!team) throw new NotFoundException();
    const [used, limits] = await Promise.all([
      this.quota.usage('team', teamId),
      this.quota.limitFor('team', teamId),
    ]);
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      isPublic: team.isPublic,
      joinPolicy: team.joinPolicy as JoinPolicy,
      owner: team.owner,
      pendingOwnerEmail: team.pendingOwners[0]?.email ?? null,
      memberCount: team._count.members,
      projectCount: team._count.projects,
      used,
      limits,
      createdAt: team.createdAt.toISOString(),
    };
  }

  /** Soft delete: the team vanishes from every list and every sync at once, and is purged after 30 days. */
  async adminDelete(teamId: string, adminId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.team.updateMany({
        where: { id: teamId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (res.count === 0) throw new NotFoundException();
      await this.audit.record(tx, { teamId, actorId: adminId, action: 'team.delete', targetKind: 'team', targetId: teamId });
    });
    this.log.log(`team ${teamId} deleted by ${adminId}`);
  }
}
