import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus.js';

/** Global: services across the app publish events without importing the realtime module. */
@Global()
@Module({ providers: [EventBus], exports: [EventBus] })
export class EventsModule {}
