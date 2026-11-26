import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { idSchema, type TeamPresenceDto } from '@os-planner/shared';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { PermissionService } from '../spaces/permission.service.js';
import { PresenceService } from './presence.service.js';

@Controller('teams')
export class RealtimeController {
  constructor(
    private readonly perms: PermissionService,
    private readonly presence: PresenceService,
  ) {}

  /** Who of the team is online or idle right now. Members only; everyone else gets 404. */
  @Get(':id/presence')
  async presenceOf(
    @CurrentUser() user: AuthUser,
    @Param('id', { schema: idSchema }) teamId: string,
  ): Promise<TeamPresenceDto> {
    if (!(await this.perms.teamAccess(user.id, teamId))) throw new NotFoundException();
    return { teamId, online: await this.presence.teamSnapshot(teamId) };
  }
}
