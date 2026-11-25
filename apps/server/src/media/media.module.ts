import { Global, Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service.js';
import { MediaController, MulterConfig } from './media.controller.js';
import { MediaService } from './media.service.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  imports: [MulterConfig],
  controllers: [MediaController],
  providers: [MediaService, StorageService, MaintenanceService],
  exports: [MediaService, StorageService, MaintenanceService],
})
export class MediaModule {}
