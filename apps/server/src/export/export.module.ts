import { Module } from '@nestjs/common';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';
import { PdfService } from './pdf.service.js';

@Module({
  controllers: [ExportController],
  providers: [ExportService, PdfService],
})
export class ExportModule {}
