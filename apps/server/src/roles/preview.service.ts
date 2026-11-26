import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  explainPermissions,
  hasPermission,
  Permission,
  permissionsToString,
  type PreviewDto,
  type PreviewQuery,
} from '@os-planner/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';

/** The id used for "somebody who holds exactly this role": it matches no real account, so no member overwrite applies. */
const SIMULATED_USER = '00000000-0000-0000-0000-000000000000';

/**
 * "View as": what a role or a member can do in a team or project, and which rule decided each permission. For
 * administrators who need to find out why a control is disabled. It runs the same engine as the guards.
 */
@Injectable()
export class PreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  async preview(userId: string, q: PreviewQuery): Promise<PreviewDto> {
    const [subjectKind, subjectId] = q.subject.split(':') as ['role' | 'member', string];

    const project = q.kind === 'project' ? await this.perms.projectAccess(userId, q.id) : null;
    const team =
      q.kind === 'project' ? (project?.team ?? null) : await this.perms.teamAccess(userId, q.id);
    if (!team) throw new NotFoundException();
    const context = project?.perms ?? team.perms;
    if (!hasPermission(context, Permission.MANAGE_ROLES)) throw new ForbiddenException('forbidden');

    const chain = project ? await this.perms.chainLevels(this.prisma, project.project.path) : [];
    const names: Record<string, string> = Object.fromEntries(team.roles.map((r) => [r.id, r.name]));
    if (project) {
      const projects = await this.prisma.project.findMany({
        where: { id: { in: chain.map((c) => c.id) } },
        select: { id: true, name: true },
      });
      for (const p of projects) names[p.id] = p.name;
    }

    let userForInput = SIMULATED_USER;
    let held = new Set<string>();
    let name: string;
    if (subjectKind === 'member') {
      const member = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: team.team.id, userId: subjectId } },
        include: { user: { select: { displayName: true } } },
      });
      if (!member) throw new NotFoundException();
      userForInput = subjectId;
      name = member.nickname || member.user.displayName;
      held = new Set(
        (
          await this.prisma.memberRole.findMany({
            where: { userId: subjectId, role: { teamId: team.team.id } },
            select: { roleId: true },
          })
        ).map((r) => r.roleId),
      );
    } else {
      const role = team.roles.find((r) => r.id === subjectId);
      if (!role || (role.projectId !== null && !chain.some((c) => c.id === role.projectId)))
        throw new NotFoundException();
      name = role.name;
      held = role.isEveryone ? new Set() : new Set([role.id]);
    }

    const input = this.perms.buildInput(team.team, team.roles, held, userForInput, chain);
    const explanation = explainPermissions(input);
    return {
      subject: { kind: subjectKind, id: subjectId, name },
      kind: q.kind,
      id: q.id,
      permissions: permissionsToString(explanation.permissions),
      decisions: explanation.decisions,
      names,
    };
  }
}
