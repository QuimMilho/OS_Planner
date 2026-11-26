import { Global, Module } from '@nestjs/common';
import { InvitesService } from './invites.service.js';
import {
  InvitesController,
  JoiningController,
  MembershipController,
} from './membership.controller.js';
import { JoiningService } from './joining.service.js';
import { MembershipService } from './membership.service.js';

/** Global so sign-up and verification can apply the invite a person registered with (InvitesService.applyPending). */
@Global()
@Module({
  controllers: [InvitesController, JoiningController, MembershipController],
  providers: [InvitesService, JoiningService, MembershipService],
  exports: [InvitesService],
})
export class MembershipModule {}
