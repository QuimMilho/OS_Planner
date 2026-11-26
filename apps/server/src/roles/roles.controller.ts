import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  auditQuerySchema,
  createRoleSchema,
  idSchema,
  overwritesQuerySchema,
  previewQuerySchema,
  reorderRolesSchema,
  setOverwriteSchema,
  updateRoleSchema,
  type AuditPageDto,
  type AuditQuery,
  type CreateRoleInput,
  type OverwriteDto,
  type OverwritesQuery,
  type PreviewDto,
  type PreviewQuery,
  type ReorderRolesInput,
  type RoleDto,
  type SetOverwriteInput,
  type UpdateRoleInput,
} from '@os-planner/shared';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { AuditService } from './audit.service.js';
import { OverwritesService } from './overwrites.service.js';
import { PreviewService } from './preview.service.js';
import { RolesService } from './roles.service.js';

const Id = () => Param('id', { schema: idSchema });
const UserParam = () => Param('userId', { schema: idSchema });
const RoleParam = () => Param('roleId', { schema: idSchema });

/** Team roles, who holds them, and the team's audit log. Not a member of the team: 404. A member without the permission: 403. */
@Controller('teams')
export class TeamRolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/roles')
  list(@CurrentUser() u: AuthUser, @Id() id: string): Promise<RoleDto[]> {
    return this.roles.list(u.id, { teamId: id });
  }

  @Post(':id/roles')
  create(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createRoleSchema }) body: CreateRoleInput,
  ): Promise<RoleDto> {
    return this.roles.create(u.id, { teamId: id }, body);
  }

  @Put(':id/roles/order')
  reorder(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: reorderRolesSchema }) body: ReorderRolesInput,
  ): Promise<RoleDto[]> {
    return this.roles.reorder(u.id, { teamId: id }, body.ids);
  }

  @HttpCode(204)
  @Put(':id/members/:userId/roles/:roleId')
  async assign(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
    @RoleParam() roleId: string,
  ): Promise<void> {
    await this.roles.assign(u.id, { teamId: id }, userId, roleId);
  }

  @HttpCode(204)
  @Delete(':id/members/:userId/roles/:roleId')
  async unassign(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
    @RoleParam() roleId: string,
  ): Promise<void> {
    await this.roles.unassign(u.id, { teamId: id }, userId, roleId);
  }

  @Get(':id/audit')
  auditLog(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: auditQuerySchema }) q: AuditQuery,
  ): Promise<AuditPageDto> {
    return this.audit.list(u.id, id, q);
  }
}

/** Roles that exist inside one project and below. */
@Controller('projects')
export class ProjectRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get(':id/roles')
  list(@CurrentUser() u: AuthUser, @Id() id: string): Promise<RoleDto[]> {
    return this.roles.list(u.id, { projectId: id });
  }

  @Post(':id/roles')
  create(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createRoleSchema }) body: CreateRoleInput,
  ): Promise<RoleDto> {
    return this.roles.create(u.id, { projectId: id }, body);
  }

  @Put(':id/roles/order')
  reorder(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: reorderRolesSchema }) body: ReorderRolesInput,
  ): Promise<RoleDto[]> {
    return this.roles.reorder(u.id, { projectId: id }, body.ids);
  }

  @HttpCode(204)
  @Put(':id/members/:userId/roles/:roleId')
  async assign(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
    @RoleParam() roleId: string,
  ): Promise<void> {
    await this.roles.assign(u.id, { projectId: id }, userId, roleId);
  }

  @HttpCode(204)
  @Delete(':id/members/:userId/roles/:roleId')
  async unassign(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
    @RoleParam() roleId: string,
  ): Promise<void> {
    await this.roles.unassign(u.id, { projectId: id }, userId, roleId);
  }
}

/** One role by id, wherever it lives. */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateRoleSchema }) body: UpdateRoleInput,
  ): Promise<RoleDto> {
    return this.roles.update(u.id, id, body);
  }

  @HttpCode(204)
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.roles.remove(u.id, id);
  }
}

@Controller('overwrites')
export class OverwritesController {
  constructor(private readonly overwrites: OverwritesService) {}

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query({ schema: overwritesQuerySchema }) q: OverwritesQuery,
  ): Promise<OverwriteDto[]> {
    return this.overwrites.list(u.id, q.kind, q.id);
  }

  /** Upsert. Allowing and denying nothing removes the overwrite (the answer is then empty). */
  @Put()
  set(
    @CurrentUser() u: AuthUser,
    @Body({ schema: setOverwriteSchema }) body: SetOverwriteInput,
  ): Promise<OverwriteDto | null> {
    return this.overwrites.set(u.id, body);
  }

  @HttpCode(204)
  @Delete(':id')
  async clear(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.overwrites.clear(u.id, id);
  }
}

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly preview: PreviewService) {}

  @Get('preview')
  view(
    @CurrentUser() u: AuthUser,
    @Query({ schema: previewQuerySchema }) q: PreviewQuery,
  ): Promise<PreviewDto> {
    return this.preview.preview(u.id, q);
  }
}
