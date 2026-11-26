import { Global, Module } from '@nestjs/common';
import { PermissionService } from './permission.service.js';
import { SpacesService } from './spaces.service.js';

/** Global: every module that touches content asks the same PermissionService. */
@Global()
@Module({
  providers: [SpacesService, PermissionService],
  exports: [SpacesService, PermissionService],
})
export class SpacesModule {}
