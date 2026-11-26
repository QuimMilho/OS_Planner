import { Logger, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Injectable } from '@nestjs/common';
import { DigestService } from './digest.service.js';
import { MentionsService } from './mentions.service.js';
import { NotificationService } from './notification.service.js';
import {
  MailActionsController,
  NotificationSettingsController,
  NotificationsController,
  PushController,
} from './notifications.controller.js';
import { PushService } from './push.service.js';
import { NotificationSettingsService } from './settings.service.js';

/** Nightly: old notifications go (they are small, and not charged to anybody's storage). */
@Injectable()
export class NotificationsMaintenance {
  private readonly log = new Logger(NotificationsMaintenance.name);
  constructor(private readonly notifications: NotificationService) {}

  @Cron('20 3 * * *')
  async nightly(): Promise<void> {
    try {
      const n = await this.notifications.prune();
      if (n) this.log.log(`removed ${n} old notifications`);
    } catch (e) {
      this.log.error(`notification cleanup failed: ${e instanceof Error ? e.stack : e}`);
    }
  }
}

/** Mentions, the inbox, per-place settings, Web Push and the per-chat email. Chat calls into it when a message is written. */
@Module({
  controllers: [
    NotificationsController,
    NotificationSettingsController,
    PushController,
    MailActionsController,
  ],
  providers: [
    NotificationSettingsService,
    MentionsService,
    NotificationService,
    PushService,
    DigestService,
    NotificationsMaintenance,
  ],
  exports: [
    NotificationSettingsService,
    MentionsService,
    NotificationService,
    PushService,
    DigestService,
  ],
})
export class NotificationsModule {}
