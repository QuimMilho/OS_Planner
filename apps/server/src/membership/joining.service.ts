import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type DirectoryPageDto,
  type DirectoryQuery,
  type DirectoryTeamDto,
  type JoinPolicy,
  type JoinRequestDto,
  type JoinRequestStatus,
  type JoinResultDto,
  type Locale,
  type MyJoinStatus,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import type { Team } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../roles/audit.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { tagsOf, TeamsService } from '../teams/teams.service.js';

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string }).code === 'P2002';

/** Joining a public team: the directory, "anyone can join" and "ask to join", and deciding on requests. */
@Injectable()
export class JoiningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly teams: TeamsService,
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------- directory

  private card(team: Team & { _count: { members: number } }, mine: MyJoinStatus): DirectoryTeamDto {
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      icon: team.icon,
      color: team.color,
      description: team.description,
      blurb: team.listingBlurb,
      tags: tagsOf(team),
      joinPolicy: team.joinPolicy as JoinPolicy,
      memberCount: team._count.members,
      mine,
    };
  }

  /** Where the person stands with each of these teams. */
  private async standing(userId: string, teamIds: string[]): Promise<Map<string, MyJoinStatus>> {
    const out = new Map<string, MyJoinStatus>();
    if (!teamIds.length) return out;
    const requested = await this.prisma.joinRequest.findMany({
      where: { userId, teamId: { in: teamIds }, pending: 1 },
      select: { teamId: true },
    });
    for (const r of requested) out.set(r.teamId, 'requested');
    const member = await this.prisma.teamMember.findMany({
      where: { userId, teamId: { in: teamIds } },
      select: { teamId: true },
    });
    for (const m of member) out.set(m.teamId, 'member');
    return out;
  }

  /**
   * Public teams only, newest letters first by name. A private team never appears, not even for its exact name, and a
   * team that banned the person does not appear for them.
   */
  async directory(userId: string, q: DirectoryQuery): Promise<DirectoryPageDto> {
    const rows = await this.prisma.team.findMany({
      where: {
        deletedAt: null,
        isPublic: true,
        bans: { none: { userId } },
        ...(q.q && {
          OR: [
            { name: { contains: q.q } },
            { listingBlurb: { contains: q.q } },
            { description: { contains: q.q } },
          ],
        }),
        ...(q.tag && { listingTags: { path: '$', array_contains: q.tag } }),
      },
      include: { _count: { select: { members: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    });
    const page = rows.slice(0, q.limit);
    const mine = await this.standing(
      userId,
      page.map((t) => t.id),
    );
    return {
      items: page.map((t) => this.card(t, mine.get(t.id) ?? 'none')),
      nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }

  async directoryOne(userId: string, slug: string): Promise<DirectoryTeamDto> {
    const team = await this.prisma.team.findFirst({
      where: { slug, deletedAt: null, isPublic: true, bans: { none: { userId } } },
      include: { _count: { select: { members: true } } },
    });
    if (!team) throw new NotFoundException();
    return this.card(team, (await this.standing(userId, [team.id])).get(team.id) ?? 'none');
  }

  // ---------------------------------------------------------------- joining

  /** A public team, or 404: a private one looks exactly like one that does not exist. */
  private async publicTeam(teamId: string): Promise<Team> {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, deletedAt: null, isPublic: true },
    });
    if (!team) throw new NotFoundException();
    return team;
  }

  private async requireVerified(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) throw new ForbiddenException('email_not_verified');
  }

  /** Policy `open`: a member at once. Policy `request`: a pending request for the people who manage members. */
  async join(userId: string, teamId: string, message: string): Promise<JoinResultDto> {
    const team = await this.publicTeam(teamId);
    await this.requireVerified(userId);
    if (await this.prisma.ban.findUnique({ where: { teamId_userId: { teamId, userId } } }))
      throw new ForbiddenException('banned');
    if (await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } }))
      return { status: 'joined', teamId };

    if (team.joinPolicy === 'open') {
      try {
        await this.prisma.$transaction(async (tx) => {
          if (!(await this.teams.addMember(tx, teamId, userId))) return;
          await tx.joinRequest.updateMany({
            where: { teamId, userId, pending: 1 },
            data: { status: 'approved', pending: null, decidedAt: new Date() },
          });
          await this.audit.record(tx, {
            teamId,
            actorId: userId,
            action: 'member.add',
            targetKind: 'member',
            targetId: userId,
            after: { via: 'directory' },
          });
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // joined twice at once
      }
      return { status: 'joined', teamId };
    }

    try {
      await this.prisma.joinRequest.create({ data: { id: newId(), teamId, userId, message } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // already waiting: asking twice changes nothing
    }
    return { status: 'requested', teamId };
  }

  /** Takes back the person's own pending request. */
  async withdraw(userId: string, teamId: string): Promise<void> {
    const res = await this.prisma.joinRequest.updateMany({
      where: { teamId, userId, pending: 1 },
      data: { status: 'withdrawn', pending: null, decidedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException();
  }

  // ---------------------------------------------------------------- deciding (MANAGE_MEMBERS)

  private async requireManager(userId: string, teamId: string) {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (!hasPermission(access.perms, Permission.MANAGE_MEMBERS))
      throw new ForbiddenException('forbidden');
    return access;
  }

  async requests(
    userId: string,
    teamId: string,
    status: JoinRequestStatus = 'pending',
  ): Promise<JoinRequestDto[]> {
    await this.requireManager(userId, teamId);
    const rows = await this.prisma.joinRequest.findMany({
      where: { teamId, status },
      include: { user: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      userId: r.userId,
      displayName: r.user.displayName,
      message: r.message,
      status: r.status as JoinRequestStatus,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
    }));
  }

  async decide(userId: string, teamId: string, requestId: string, approve: boolean): Promise<void> {
    const access = await this.requireManager(userId, teamId);
    const request = await this.prisma.joinRequest.findFirst({
      where: { id: requestId, teamId, pending: 1 },
    });
    if (!request) throw new NotFoundException();

    await this.prisma.$transaction(async (tx) => {
      // Claimed atomically: two people deciding at once cannot both win.
      const claimed = await tx.joinRequest.updateMany({
        where: { id: requestId, pending: 1 },
        data: {
          status: approve ? 'approved' : 'denied',
          pending: null,
          decidedBy: userId,
          decidedAt: new Date(),
        },
      });
      if (claimed.count === 0) throw new NotFoundException();
      if (approve) {
        if (
          await tx.ban.findUnique({ where: { teamId_userId: { teamId, userId: request.userId } } })
        )
          throw new ForbiddenException('banned');
        await this.teams.addMember(tx, teamId, request.userId); // 413 when the team is full: the request stays pending
      }
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: approve ? 'request.approve' : 'request.deny',
        targetKind: 'member',
        targetId: request.userId,
        after: { requestId },
      });
    });

    const person = await this.prisma.user.findUnique({
      where: { id: request.userId },
      select: { email: true, displayName: true, locale: true },
    });
    if (person)
      await this.mail.sendRequestDecision(
        person.email,
        person.displayName,
        person.locale as Locale,
        access.team.name,
        approve,
      );
  }
}
