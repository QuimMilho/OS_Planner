import { Module } from '@nestjs/common';
import { DownloadsController, ReleaseTokenGuard } from './downloads.controller.js';
import { DownloadsService } from './downloads.service.js';

@Module({
  controllers: [DownloadsController],
  providers: [DownloadsService, ReleaseTokenGuard],
})
export class DownloadsModule {}
