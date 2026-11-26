import { Global, Module } from '@nestjs/common';
import { PresenceService } from './presence.service.js';
import { RealtimeBridge } from './realtime.bridge.js';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeServer } from './realtime.server.js';
import { RoomAuthorizer } from './room-authorizer.js';

/** Global: features register their rooms with the RoomAuthorizer, and health and admin read the server's state. */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeServer, RoomAuthorizer, PresenceService, RealtimeGateway, RealtimeBridge],
  exports: [RealtimeServer, RoomAuthorizer, PresenceService],
})
export class RealtimeModule {}
