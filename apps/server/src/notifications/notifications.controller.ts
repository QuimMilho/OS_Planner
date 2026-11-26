import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  idSchema,
  type EffectiveSettingDto,
  type ListNotificationsQuery,
  type MailActionResultDto,
  type MuteInput,
  type NotificationCountDto,
  type NotificationPageDto,
  type NotificationSettingDto,
  type PushDeviceDto,
  type PushSubscribeInput,
  type PutSettingInput,
  type QuietHoursDto,
  type ReadNotificationsInput,
  type VapidKeyDto,
} from '@os-planner/shared';
import {
  effectiveQuerySchema,
  listNotificationsSchema,
  mailActionSchema,
  muteSchema,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  putSettingSchema,
  quietHoursSchema,
  readNotificationsSchema,
} from '@os-planner/shared/chat';
import type { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { DigestService } from './digest.service.js';
import { NotificationService } from './notification.service.js';
import { PushService } from './push.service.js';
import { NotificationSettingsService } from './settings.service.js';

/** The inbox, its counters and the person's quiet hours. */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly settings: NotificationSettingsService,
  ) {}

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query({ schema: listNotificationsSchema }) q: ListNotificationsQuery,
  ): Promise<NotificationPageDto> {
    return this.notifications.list(u.id, q);
  }

  @Get('count')
  count(@CurrentUser() u: AuthUser): Promise<NotificationCountDto> {
    return this.notifications.count(u.id);
  }

  @HttpCode(204)
  @Post('read')
  async read(
    @CurrentUser() u: AuthUser,
    @Body({ schema: readNotificationsSchema }) body: ReadNotificationsInput,
  ): Promise<void> {
    await this.notifications.markRead(u.id, body);
  }

  /** The person's quiet hours; 204 when they have none. */
  @Get('quiet-hours')
  async quiet(
    @CurrentUser() u: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuietHoursDto | undefined> {
    const hours = await this.settings.quietHours(u.id);
    if (!hours) res.status(204);
    return hours ?? undefined;
  }

  @Put('quiet-hours')
  setQuiet(
    @CurrentUser() u: AuthUser,
    @Body({ schema: quietHoursSchema }) body: QuietHoursDto,
  ): Promise<QuietHoursDto | null> {
    return this.settings.setQuietHours(u.id, body);
  }
}

/** What the person wants for each place, and what is in effect there. */
@Controller('notification-settings')
export class NotificationSettingsController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser): Promise<NotificationSettingDto[]> {
    return this.settings.list(u.id);
  }

  @Get('effective')
  effective(
    @CurrentUser() u: AuthUser,
    @Query({ schema: effectiveQuerySchema }) q: z.infer<typeof effectiveQuerySchema>,
  ): Promise<EffectiveSettingDto> {
    return this.settings.effective(u.id, q.scopeKind, q.scopeId ?? null);
  }

  /** Sets what is given for one place. 204 when that leaves nothing set there (the row is gone). */
  @Put()
  async put(
    @CurrentUser() u: AuthUser,
    @Body({ schema: putSettingSchema }) body: PutSettingInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotificationSettingDto | undefined> {
    const row = await this.settings.put(u.id, body);
    if (!row) res.status(204);
    return row ?? undefined;
  }

  @Post('mute')
  async mute(
    @CurrentUser() u: AuthUser,
    @Body({ schema: muteSchema }) body: MuteInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotificationSettingDto | undefined> {
    const row = await this.settings.mute(u.id, body);
    res.status(row ? 200 : 204);
    return row ?? undefined;
  }

  @HttpCode(204)
  @Delete(':id')
  async remove(
    @CurrentUser() u: AuthUser,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<void> {
    await this.settings.remove(u.id, id);
  }
}

/** Web Push: the key to subscribe with, and the devices of the person. Without VAPID keys all of it answers 404. */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-key')
  key(): VapidKeyDto {
    return this.push.vapidKey();
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('subscribe')
  subscribe(
    @CurrentUser() u: AuthUser,
    @Body({ schema: pushSubscribeSchema }) body: PushSubscribeInput,
  ): Promise<PushDeviceDto> {
    return this.push.subscribe(u.id, body);
  }

  @HttpCode(204)
  @Delete('subscribe')
  async unsubscribe(
    @CurrentUser() u: AuthUser,
    @Body({ schema: pushUnsubscribeSchema }) body: z.infer<typeof pushUnsubscribeSchema>,
  ): Promise<void> {
    await this.push.unsubscribe(u.id, body.endpoint);
  }

  @Get('devices')
  devices(@CurrentUser() u: AuthUser): Promise<PushDeviceDto[]> {
    return this.push.devices(u.id);
  }

  @HttpCode(204)
  @Delete('devices/:id')
  async removeDevice(
    @CurrentUser() u: AuthUser,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<void> {
    await this.push.removeDevice(u.id, id);
  }
}

/** The links in a notification email. No login: the signed link says who and what. */
@Controller('mail')
export class MailActionsController {
  constructor(private readonly digest: DigestService) {}

  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('unsubscribe')
  unsubscribe(
    @Body({ schema: mailActionSchema }) body: z.infer<typeof mailActionSchema>,
  ): Promise<MailActionResultDto> {
    return this.digest.applyAction(body.token);
  }
}
