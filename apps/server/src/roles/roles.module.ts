import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { OverwritesService } from './overwrites.service.js';
import { PreviewService } from './preview.service.js';
import { RoleHierarchy } from './role-hierarchy.service.js';
import {
  OverwritesController,
  PermissionsController,
  ProjectRolesController,
  RolesController,
  TeamRolesController,
} from './roles.controller.js';
import { RolesService } from './roles.service.js';

/** Global: teams, projects and quotas write audit entries, and removing a member checks the last-administrator rule. */
@Global()
@Module({
  controllers: [
    TeamRolesController,
    ProjectRolesController,
    RolesController,
    OverwritesController,
    PermissionsController,
  ],
  providers: [AuditService, RoleHierarchy, RolesService, OverwritesService, PreviewService],
  exports: [AuditService, RoleHierarchy],
})
export class RolesModule {}
