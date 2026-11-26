import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  checkRoleAction,
  EMAIL_INVITE_DAYS,
  hasPermission,
  LINK_INVITE_DAYS,
  Permission,
  type AcceptedInviteDto,
  type CreateInviteInput,
  type CreatedInviteDto,
  type InviteDto,
  type InvitePreviewDto,
  type InviteStatus,
  type Locale,
} from '@os-planner/shared';
import { newId, randomToken, safeEqualHex, sha256Hex } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import type { Invite } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditService } from '../roles/audit.service.js';
import { RoleHierarchy, targetOf } from '../roles/role-hierarchy.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { TeamsService } from '../teams/teams.service.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every way an invite can be unusable (unknown, expired, revoked, used up, team gone, person banned) answers the same
 * 404 with the same body, so a token reveals nothing to someone who should not have it.
 */
const invalid = () => new NotFoundException('invalid_invite');

type Usable = Invite & {
  memberCount: number;
  team: { name: string; icon: string | null; color: string | null };
};

const idsOf = (inv: Invite): string[] =>
  Array.isArray(inv.roleIds) ? (inv.roleIds as string[]) : [];

/**
 * Invitations to a team: to one email address or as a link. The token is 32 random bytes; only its SHA-256 hash is
 * stored, so it is shown exactly once (in the mail, or in the answer that creates a link).
 */
@Injectable()
export class InvitesService {
  private readonly log = new Logger(InvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly hierarchy: RoleHierarchy,
    private readonly audit: AuditService,
    private readonly teams: TeamsService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------- helpers

  private statusOf(inv: Invite, now = new Date()): InviteStatus {
    if (inv.revokedAt) return 'revoked';
    if (
      inv.kind === 'email'
        ? inv.acceptedAt !== null
        : inv.maxUses !== null && inv.uses >= inv.maxUses
    )
      return 'used';
    if (inv.expiresAt <= now) return 'expired';
    return 'active';
  }

  private url(token: string): string {
    return `${this.env.APP_URL.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`;
  }

  private toDto(inv: Invite, names: Map<string, string>): InviteDto {
    const person = (id: string | null) => (id ? { id, displayName: names.get(id) ?? '' } : null);
    return {
      id: inv.id,
      teamId: inv.teamId,
      kind: inv.kind as 'email' | 'link',
      email: inv.email,
      projectId: inv.projectId,
      roleIds: idsOf(inv),
      maxUses: inv.maxUses,
      uses: inv.uses,
      expiresAt: inv.expiresAt.toISOString(),
      revokedAt: inv.revokedAt?.toISOString() ?? null,
      createdAt: inv.createdAt.toISOString(),
      invitedBy: person(inv.invitedBy),
      acceptedBy: person(inv.acceptedBy),
      acceptedAt: inv.acceptedAt?.toISOString() ?? null,
      status: this.statusOf(inv),
    };
  }

  private async namesOf(invites: Invite[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        invites.flatMap((i) => [i.invitedBy, i.acceptedBy]).filter((x): x is string => !!x),
      ),
    ];
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  /** The invite a token belongs to, if the token is genuine. The comparison does not depend on how much of it matched. */
  private async byToken(token: string): Promise<Invite | null> {
    const hash = sha256Hex(token);
    const inv = await this.prisma.invite.findUnique({ where: { tokenHash: hash } });
    return inv && safeEqualHex(inv.tokenHash, hash) ? inv : null;
  }

  private async usable(token: string): Promise<Usable | null> {
    const inv = await this.byToken(token);
    return inv ? this.describe(inv) : null;
  }

  /** The invite, if it can still be used right now and its team exists. */
  private async describe(inv: Invite): Promise<Usable | null> {
    if (this.statusOf(inv) !== 'active') return null;
    const team = await this.prisma.team.findFirst({
      where: { id: inv.teamId, deletedAt: null },
      select: { name: true, icon: true, color: true, _count: { select: { members: true } } },
    });
    if (!team) return null;
    return { ...inv, team, memberCount: team._count.members };
  }

  // ---------------------------------------------------------------- creating and managing (CREATE_INVITES)

  private async requireInviter(userId: string, teamId: string) {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (!hasPermission(access.perms, Permission.CREATE_INVITES))
      throw new ForbiddenException('forbidden');
    return access;
  }

  async create(
    userId: string,
    teamId: string,
    input: CreateInviteInput,
  ): Promise<CreatedInviteDto> {
    const access = await this.requireInviter(userId, teamId);

    // A project to join: a top-level project of this team that the inviter manages. (A sub-project needs its parent's
    // membership too; inviting straight into one would hand out access to the parent, so it is not offered.)
    if (input.projectId) {
      const project = await this.perms.projectAccess(userId, input.projectId);
      if (!project || project.project.teamId !== teamId) throw new NotFoundException();
      if (!hasPermission(project.perms, Permission.MANAGE_PROJECTS))
        throw new ForbiddenException('forbidden');
      if (project.project.parentId)
        throw new UnprocessableEntityException('project_must_be_top_level');
    }

    // Roles the invited person gets: the inviter must be allowed to give each of them (MANAGE_ROLES, strictly below
    // their own rank, no permission they lack), exactly as if they assigned them by hand.
    if (input.roleIds.length) {
      const scope = await this.hierarchy.scope(
        userId,
        input.projectId ? { projectId: input.projectId } : { teamId },
      );
      for (const roleId of new Set(input.roleIds)) {
        const role = access.roles.find((r) => r.id === roleId);
        if (
          !role ||
          role.isEveryone ||
          (role.projectId !== null && role.projectId !== input.projectId)
        )
          throw new UnprocessableEntityException('invalid_role');
        this.hierarchy.enforce(checkRoleAction(scope.actor, 'assign', targetOf(role)));
      }
    }

    const isLink = input.link === true;
    const days = input.expiresInDays ?? (isLink ? LINK_INVITE_DAYS : EMAIL_INVITE_DAYS);
    const token = randomToken();
    const now = new Date();
    const email = isLink ? null : input.email!;

    const inv = await this.prisma.$transaction(async (tx) => {
      // A newer invitation to the same address replaces the older ones, so the list does not pile up.
      if (email)
        await tx.invite.updateMany({
          where: { teamId, email, revokedAt: null, acceptedAt: null },
          data: { revokedAt: now },
        });
      const row = await tx.invite.create({
        data: {
          id: newId(),
          teamId,
          projectId: input.projectId ?? null,
          kind: isLink ? 'link' : 'email',
          email,
          tokenHash: sha256Hex(token),
          roleIds: [...new Set(input.roleIds)],
          invitedBy: userId,
          maxUses: isLink ? (input.maxUses ?? null) : null,
          expiresAt: new Date(now.getTime() + days * DAY),
        },
      });
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'invite.create',
        targetKind: 'invite',
        targetId: row.id,
        after: {
          kind: row.kind,
          email: row.email,
          roleIds: idsOf(row),
          projectId: row.projectId,
          maxUses: row.maxUses,
          expiresAt: row.expiresAt,
        },
      });
      return row;
    });

    if (email) await this.sendMail(userId, access.team.name, email, token, days);
    return { ...this.toDto(inv, await this.namesOf([inv])), url: isLink ? this.url(token) : null };
  }

  private async sendMail(
    inviterId: string,
    teamName: string,
    to: string,
    token: string,
    days: number,
  ): Promise<void> {
    const inviter = await this.prisma.user.findUnique({
      where: { id: inviterId },
      select: { displayName: true, locale: true },
    });
    await this.mail.sendInvite(
      to,
      (inviter?.locale ?? 'en') as Locale,
      inviter?.displayName ?? '',
      teamName,
      token,
      days,
    );
  }

  async list(userId: string, teamId: string): Promise<InviteDto[]> {
    await this.requireInviter(userId, teamId);
    const rows = await this.prisma.invite.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const names = await this.namesOf(rows);
    return rows.map((r) => this.toDto(r, names));
  }

  /** Revoking something already revoked (or used) changes nothing. */
  async revoke(userId: string, inviteId: string): Promise<void> {
    const inv = await this.prisma.invite.findUnique({ where: { id: inviteId } });
    if (!inv) throw new NotFoundException();
    await this.requireInviter(userId, inv.teamId);
    if (inv.revokedAt) return;
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.invite.updateMany({
        where: { id: inviteId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (res.count === 0) return;
      await tx.pendingInvite.deleteMany({ where: { inviteId } });
      await this.audit.record(tx, {
        teamId: inv.teamId,
        actorId: userId,
        action: 'invite.revoke',
        targetKind: 'invite',
        targetId: inviteId,
        before: { kind: inv.kind, email: inv.email, uses: inv.uses },
      });
    });
  }

  /** A new token (the old one stops working) and a fresh expiry, sent to the same address again. */
  async resend(userId: string, inviteId: string): Promise<InviteDto> {
    const inv = await this.prisma.invite.findUnique({ where: { id: inviteId } });
    if (!inv) throw new NotFoundException();
    const access = await this.requireInviter(userId, inv.teamId);
    if (inv.kind !== 'email' || !inv.email)
      throw new UnprocessableEntityException('not_an_email_invite');
    if (inv.revokedAt || inv.acceptedAt) throw new UnprocessableEntityException('invite_closed');

    const token = randomToken();
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.invite.update({
        where: { id: inviteId },
        data: {
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + EMAIL_INVITE_DAYS * DAY),
        },
      });
      await this.audit.record(tx, {
        teamId: inv.teamId,
        actorId: userId,
        action: 'invite.resend',
        targetKind: 'invite',
        targetId: inviteId,
        after: { email: inv.email, expiresAt: updated.expiresAt },
      });
      return updated;
    });
    await this.sendMail(userId, access.team.name, inv.email, token, EMAIL_INVITE_DAYS);
    return this.toDto(row, await this.namesOf([row]));
  }

  // ---------------------------------------------------------------- strangers and the person accepting

  /** What a visitor holding the link may see before signing in: the team's name, icon and size. Never who is in it. */
  async preview(token: string): Promise<InvitePreviewDto> {
    const inv = await this.usable(token);
    if (!inv) throw invalid();
    return {
      teamName: inv.team.name,
      icon: inv.team.icon,
      color: inv.team.color,
      memberCount: inv.memberCount,
    };
  }

  async accept(userId: string, token: string): Promise<AcceptedInviteDto> {
    const inv = await this.usable(token);
    if (!inv) throw invalid();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) throw invalid();
    // Joining a team needs an address the person has proved they own: that is also what an email invite is checked against.
    if (!user.emailVerifiedAt) throw new ForbiddenException('email_not_verified');
    if (inv.kind === 'email' && inv.email?.toLowerCase() !== user.email.toLowerCase())
      throw new ForbiddenException('invite_other_address');
    return this.join(user.id, inv);
  }

  /** Consumes one use of the invite and makes the person a member, or does nothing if they already are. */
  private async join(userId: string, inv: Invite): Promise<AcceptedInviteDto> {
    const now = new Date();
    try {
      const joined = await this.prisma.$transaction(async (tx) => {
        if (await tx.ban.findUnique({ where: { teamId_userId: { teamId: inv.teamId, userId } } }))
          throw invalid();
        // Locks the team, so joins are one at a time and the member limit holds (413 when it is full).
        const added = await this.teams.addMember(tx, inv.teamId, userId);
        if (!added) return false;

        // Atomic: of two simultaneous accepts only as many succeed as the invite allows.
        const used =
          inv.kind === 'email'
            ? await tx.$executeRaw`UPDATE \`Invite\` SET \`uses\` = \`uses\` + 1, \`acceptedBy\` = ${userId}, \`acceptedAt\` = ${now}
                WHERE \`id\` = ${inv.id} AND \`revokedAt\` IS NULL AND \`expiresAt\` > ${now} AND \`acceptedAt\` IS NULL`
            : await tx.$executeRaw`UPDATE \`Invite\` SET \`uses\` = \`uses\` + 1
                WHERE \`id\` = ${inv.id} AND \`revokedAt\` IS NULL AND \`expiresAt\` > ${now}
                AND (\`maxUses\` IS NULL OR \`uses\` < \`maxUses\`)`;
        if (used === 0) throw invalid();

        const applied = await this.applyRoles(tx, inv, userId);
        await tx.pendingInvite.deleteMany({ where: { inviteId: inv.id, userId } });
        await tx.joinRequest.updateMany({
          where: { teamId: inv.teamId, userId, pending: 1 },
          data: { status: 'approved', pending: null, decidedAt: now },
        });
        await this.audit.record(tx, {
          teamId: inv.teamId,
          actorId: userId,
          action: 'member.add',
          targetKind: 'member',
          targetId: userId,
          after: {
            via: inv.kind === 'email' ? 'invite' : 'link',
            inviteId: inv.id,
            invitedBy: inv.invitedBy,
            ...applied,
          },
        });
        return true;
      });
      return { teamId: inv.teamId, joined };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return { teamId: inv.teamId, joined: false }; // joined at the same moment elsewhere
      throw e;
    }
  }

  /**
   * Gives the roles (and the project) the invite carries, as far as whoever made it may still give them today: an
   * inviter who left, or lost the right to hand out a role since, does not lend it to a link that is still around.
   */
  private async applyRoles(
    tx: Tx,
    inv: Invite,
    userId: string,
  ): Promise<{ roleIds: string[]; projectId: string | null }> {
    const wanted = idsOf(inv);
    let projectId: string | null = null;
    if (inv.projectId) {
      const project = await tx.project.findFirst({
        where: { id: inv.projectId, teamId: inv.teamId, deletedAt: null, parentId: null },
        select: { id: true },
      });
      if (project) {
        await tx.projectMember.createMany({
          data: [{ projectId: project.id, userId }],
          skipDuplicates: true,
        });
        projectId = project.id;
      }
    }
    if (!wanted.length || !inv.invitedBy) return { roleIds: [], projectId };

    const roles = await tx.role.findMany({
      where: { id: { in: wanted }, teamId: inv.teamId, isEveryone: false },
    });
    const allowed: string[] = [];
    let actor;
    try {
      actor = (
        await this.hierarchy.scope(
          inv.invitedBy,
          projectId ? { projectId } : { teamId: inv.teamId },
          tx,
        )
      ).actor;
    } catch {
      return { roleIds: [], projectId }; // the inviter is no longer in the team (or the project)
    }
    for (const role of roles) {
      if (role.projectId !== null && role.projectId !== projectId) continue;
      if (checkRoleAction(actor, 'assign', targetOf(role)) === null) allowed.push(role.id);
    }
    if (allowed.length)
      await tx.memberRole.createMany({
        data: allowed.map((roleId) => ({ userId, roleId })),
        skipDuplicates: true,
      });
    return { roleIds: allowed, projectId };
  }

  // ---------------------------------------------------------------- registering with an invite

  /**
   * Remembers that a new account came with this invite; it is applied once the address is verified. A token that does
   * not work is ignored without a word: registering must not tell anyone whether a token was good.
   */
  async attachToRegistration(userId: string, token: string): Promise<void> {
    try {
      const inv = await this.usable(token);
      if (inv) await this.prisma.pendingInvite.create({ data: { userId, inviteId: inv.id } });
    } catch (e) {
      this.log.warn(
        `could not attach an invite to a registration: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Called whenever somebody signs in or verifies their address: invites they registered with are accepted as soon as
   * the address is verified (and, for an email invite, equals the one it was sent to). One that no longer works is dropped.
   */
  async applyPending(userId: string): Promise<number> {
    const pending = await this.prisma.pendingInvite.findMany({
      where: { userId },
      include: { invite: true },
    });
    if (!pending.length) return 0;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) return 0;

    let joined = 0;
    for (const p of pending) {
      try {
        const inv = await this.describe(p.invite);
        const fits =
          inv && (inv.kind === 'link' || inv.email?.toLowerCase() === user.email.toLowerCase());
        if (fits && (await this.join(userId, p.invite)).joined) joined++;
      } catch (e) {
        this.log.log(
          `invite ${p.inviteId} not applied for ${userId}: ${e instanceof Error ? e.message : e}`,
        );
      }
      await this.prisma.pendingInvite.deleteMany({ where: { userId, inviteId: p.inviteId } });
    }
    return joined;
  }
}
