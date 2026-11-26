import { Global, Module } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';
import { ProjectsController, TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';

/** Global so sign-in can hand over teams that were created for an email address (TeamsService.claimPending). */
@Global()
@Module({
  controllers: [TeamsController, ProjectsController],
  providers: [TeamsService, ProjectsService],
  exports: [TeamsService, ProjectsService],
})
export class TeamsModule {}
