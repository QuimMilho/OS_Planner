import { Global, Module } from '@nestjs/common';
import { CollabRegistry } from './collab.registry.js';
import { CollabServer } from './collab.server.js';
import { CollabService } from './collab.service.js';
import { SnapshotsController } from './snapshots.controller.js';
import { SnapshotsService } from './snapshots.service.js';

/** Global: the page service asks the registry whether somebody is editing a page, and health/admin read the server state. */
@Global()
@Module({
  controllers: [SnapshotsController],
  providers: [CollabRegistry, CollabService, CollabServer, SnapshotsService],
  exports: [CollabRegistry, CollabService, CollabServer],
})
export class CollabModule {}
