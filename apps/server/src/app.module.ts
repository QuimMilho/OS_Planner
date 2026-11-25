import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './config/env.js';
import { DownloadsModule } from './downloads/downloads.module.js';
import { ExportModule } from './export/export.module.js';
import { HealthController } from './health.controller.js';
import { MailModule } from './mail/mail.module.js';
import { MediaModule } from './media/media.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SearchModule } from './search/search.module.js';
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
    MailModule,
    AuthModule,
    UsersModule,
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
