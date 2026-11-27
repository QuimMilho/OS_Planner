import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ExternalCalendarsService } from './external.service.js';
import { FeedsService } from './feeds.service.js';
import { IcsFetcher } from './ics-fetcher.js';
import { IcsImportService } from './import.service.js';
import { FeedsPublicController, IcsController } from './ics.controller.js';

/** Calendar files (phase 14): the private feed, calendars followed from elsewhere, import. Export of events lives with the calendar. */
@Module({
  imports: [CalendarModule, NotificationsModule],
  controllers: [IcsController, FeedsPublicController],
  providers: [IcsFetcher, ExternalCalendarsService, FeedsService, IcsImportService],
  exports: [IcsFetcher, ExternalCalendarsService, FeedsService],
})
export class IcsModule {}
