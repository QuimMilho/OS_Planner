import { Global, Module } from '@nestjs/common';
import { LinksService } from './links.service.js';
import { SharesService } from './shares.service.js';
import { PublicLinksController, SharingController } from './sharing.controller.js';

/** Global: sync lists the notebooks shared with a person, and signing in applies the shares that waited for an address. */
@Global()
@Module({
  controllers: [SharingController, PublicLinksController],
  providers: [SharesService, LinksService],
  exports: [SharesService, LinksService],
})
export class SharingModule {}
