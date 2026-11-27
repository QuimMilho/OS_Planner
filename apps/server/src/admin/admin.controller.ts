import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  adminQuotaParamsSchema,
  adminUsersQuerySchema,
  createTeamSchema,
  idSchema,
  quotaOverrideSchema,
  type AdminQuotaDto,
  type AdminStatsDto,
  type AdminTeamDto,
  type CreateTeamInput,
  type AdminUsersPage,
  type QuotaOverrideInput,
  type CollabStatsDto,
  type RealtimeStatsDto,
} from '@os-planner/shared';
import { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { CollabServer } from '../collab/collab.server.js';
import { CollabService } from '../collab/collab.service.js';
import { RealtimeServer } from '../realtime/realtime.server.js';
import { QuotaService } from '../quota/quota.service.js';
import { TeamsService } from '../teams/teams.service.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';
import { Authz } from '../common/authz.js';

type QuotaParams = z.infer<typeof adminQuotaParamsSchema>;

/**
 * Instance administration. `@Public()` only switches the global sign-in guard off: AdminGuard
 * does its own check and answers 404 to everyone who is not an admin.
 */
@Public()
@UseGuards(AdminGuard)
@Authz({ scope: 'admin' })
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly quota: QuotaService,
    private readonly teams: TeamsService,
    private readonly realtime: RealtimeServer,
    private readonly collab: CollabServer,
    private readonly collabStats: CollabService,
  ) {}

  /** Connections and rooms of the instance that answers, and what the gateway has dropped or refused. */
  @Get('collab')
  collabStatsDto(): Promise<CollabStatsDto> {
    return this.collabStats.stats(this.collab.snapshot());
  }

  @Get('realtime')
  realtimeStats(): RealtimeStatsDto {
    return this.realtime.snapshot();
  }

  @Get('users')
  users(
    @Query({ schema: adminUsersQuerySchema }) q: z.infer<typeof adminUsersQuerySchema>,
  ): Promise<AdminUsersPage> {
    return this.admin.users(q.q, q.cursor);
  }

  @Get('stats')
  stats(): Promise<AdminStatsDto> {
    return this.admin.stats();
  }

  @Get('quotas/:scope/:id')
  quotaOf(@Param({ schema: adminQuotaParamsSchema }) p: QuotaParams): Promise<AdminQuotaDto> {
    return this.quota.adminView(p.scope, p.id);
  }

  @Put('quotas/:scope/:id')
  setQuota(
    @CurrentUser() admin: AuthUser,
    @Param({ schema: adminQuotaParamsSchema }) p: QuotaParams,
    @Body({ schema: quotaOverrideSchema }) body: QuotaOverrideInput,
  ): Promise<AdminQuotaDto> {
    return this.quota.setOverride(p.scope, p.id, body, admin.id);
  }

  @Delete('quotas/:scope/:id')
  clearQuota(
    @CurrentUser() admin: AuthUser,
    @Param({ schema: adminQuotaParamsSchema }) p: QuotaParams,
  ): Promise<AdminQuotaDto> {
    return this.quota.clearOverride(p.scope, p.id, admin.id);
  }

  @Get('teams')
  teamList(): Promise<AdminTeamDto[]> {
    return this.teams.adminList();
  }

  /** Creates a team and names its owner by email (waiting for them when they have no verified account yet). */
  @Post('teams')
  createTeam(
    @CurrentUser() admin: AuthUser,
    @Body({ schema: createTeamSchema }) body: CreateTeamInput,
  ): Promise<AdminTeamDto> {
    return this.teams.adminCreate(body, admin.id);
  }

  @HttpCode(204)
  @Delete('teams/:id')
  async deleteTeam(
    @CurrentUser() admin: AuthUser,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<void> {
    await this.teams.adminDelete(id, admin.id);
  }
}
