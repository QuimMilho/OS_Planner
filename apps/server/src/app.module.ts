import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './config/env.js';
import { DownloadsModule } from './downloads/downloads.module.js';
import { EventsModule } from './events/events.module.js';
import { ExportModule } from './export/export.module.js';
import { HealthController } from './health.controller.js';
import { MailModule } from './mail/mail.module.js';
import { MembershipModule } from './membership/membership.module.js';
import { MediaModule } from './media/media.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QuotaModule } from './quota/quota.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RolesModule } from './roles/roles.module.js';
import { SearchModule } from './search/search.module.js';
import { SharingModule } from './sharing/sharing.module.js';
import { SpacesModule } from './spaces/spaces.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { TreeModule } from './tree/tree.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        // Integration tests hammer the auth routes from one IP; a dedicated test covers throttling.
        skipIf: () => env.THROTTLE_DISABLED,
      }),
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    EventsModule,
    RealtimeModule,
    ChatModule,
    SpacesModule,
    RolesModule,
    QuotaModule,
    TeamsModule,
    MembershipModule,
    MailModule,
    AuthModule,
    UsersModule,
    AdminModule,
    SharingModule,
    TreeModule,
    MediaModule,
    SearchModule,
    DownloadsModule,
    ExportModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
