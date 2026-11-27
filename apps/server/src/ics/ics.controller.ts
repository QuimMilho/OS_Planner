import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import {
  idSchema,
  type CalendarDto,
  type CalendarFeedDto,
  type CalendarFeedSecretDto,
  type ExternalCalendarDto,
  type IcsImportPreviewDto,
  type IcsImportResultDto,
} from '@os-planner/shared';
import {
  ICS_LIMITS,
  createExternalSchema,
  createFeedSchema,
  importFieldsSchema,
  updateExternalSchema,
  updateFeedSchema,
  type CreateExternalInput,
  type CreateFeedInput,
  type ImportFields,
  type UpdateExternalInput,
  type UpdateFeedInput,
} from '@os-planner/shared/ics';
import { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { invalid } from '../tree/tree.error.js';
import { ExternalCalendarsService } from './external.service.js';
import { FeedsService } from './feeds.service.js';
import { IcsImportService } from './import.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });
const windowQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

/** Subscription feeds, followed calendars and import: what a person manages about the world outside their calendar. */
@Controller()
export class IcsController {
  constructor(
    private readonly feeds: FeedsService,
    private readonly external: ExternalCalendarsService,
    private readonly importer: IcsImportService,
  ) {}

  // ---- feeds (the private addresses other apps follow)

  @Authz({ scope: 'self' })
  @Get('me/feeds')
  listFeeds(@CurrentUser() u: AuthUser): Promise<CalendarFeedDto[]> {
    return this.feeds.list(u.id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Authz({ scope: 'self' })
  @Post('me/feeds')
  createFeed(
    @CurrentUser() u: AuthUser,
    @Body({ schema: createFeedSchema }) body: CreateFeedInput,
  ): Promise<CalendarFeedSecretDto> {
    return this.feeds.create(u.id, body);
  }

  @Authz({ scope: 'own' })
  @Patch('me/feeds/:id')
  updateFeed(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateFeedSchema }) body: UpdateFeedInput,
  ): Promise<CalendarFeedDto> {
    return this.feeds.update(u.id, id, body);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Authz({ scope: 'own' })
  @Post('me/feeds/:id/rotate')
  @HttpCode(200)
  rotateFeed(@CurrentUser() u: AuthUser, @Id() id: string): Promise<CalendarFeedSecretDto> {
    return this.feeds.rotate(u.id, id);
  }

  @Authz({ scope: 'own' })
  @Delete('me/feeds/:id')
  @HttpCode(204)
  async removeFeed(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.feeds.remove(u.id, id);
  }

  // ---- calendars the person follows

  @Authz({ scope: 'self' })
  @Get('me/external-calendars')
  listExternal(@CurrentUser() u: AuthUser): Promise<ExternalCalendarDto[]> {
    return this.external.list(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Authz({ scope: 'self' })
  @Post('me/external-calendars')
  createExternal(
    @CurrentUser() u: AuthUser,
    @Body({ schema: createExternalSchema }) body: CreateExternalInput,
  ): Promise<ExternalCalendarDto> {
    return this.external.create(u.id, body);
  }

  @Authz({ scope: 'own' })
  @Patch('me/external-calendars/:id')
  updateExternal(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateExternalSchema }) body: UpdateExternalInput,
  ): Promise<ExternalCalendarDto> {
    return this.external.update(u.id, id, body);
  }

  @Authz({ scope: 'own' })
  @Delete('me/external-calendars/:id')
  @HttpCode(204)
  async removeExternal(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.external.remove(u.id, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Authz({ scope: 'own' })
  @Post('me/external-calendars/:id/refresh')
  @HttpCode(200)
  refreshExternal(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ExternalCalendarDto> {
    return this.external.refresh(u.id, id);
  }

  @Authz({ scope: 'own' })
  @Get('me/external-calendars/:id/events')
  externalEvents(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: windowQuery }) q: z.infer<typeof windowQuery>,
  ): Promise<CalendarDto> {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from)) throw invalid('window_invalid');
    if (to.getTime() - from.getTime() > 731 * 86_400_000) throw invalid('window_too_large');
    return this.external.events(u.id, id, from, to);
  }

  // ---- import

  /** `mode=preview` lists what the file holds; `mode=commit` creates the events (the ones named in `uids`, or all). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Authz({ scope: 'self', note: 'the target space is in the fields: CREATE_MEETINGS there' })
  @Post('calendar/import')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: ICS_LIMITS.maxBytes, files: 1, fields: 6, fieldSize: 250_000 },
    }),
  )
  import(
    @CurrentUser() u: AuthUser,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body({ schema: importFieldsSchema }) fields: ImportFields,
  ): Promise<IcsImportPreviewDto | IcsImportResultDto> {
    return this.importer.run(u.id, file?.buffer, fields);
  }
}

/** The address calendar apps fetch. No sign-in: the secret in the address is the key. */
@Controller('feeds')
export class FeedsPublicController {
  constructor(private readonly feeds: FeedsService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Authz({ scope: 'secret', note: 'the feed address is the key; permissions are applied when it is read' })
  @Get(':file')
  async get(
    @Param('file') file: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Headers('if-modified-since') ifModifiedSince: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const a = await this.feeds.answer(file, { ifNoneMatch, ifModifiedSince });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', a.etag);
    res.setHeader('Last-Modified', a.lastModified);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (a.status === 304) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="calendar.ics"');
    res.send(a.body);
  }
}
