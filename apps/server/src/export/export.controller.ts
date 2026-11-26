import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { exportMarkdownQuerySchema, exportPdfSchema, type ExportPdfInput } from '@os-planner/shared';
import type { z } from 'zod';
import { CurrentUser, RequireVerified, type AuthUser } from '../common/auth.decorators.js';
import { ExportService } from './export.service.js';
import { attachment } from './forest.js';

@Controller('export')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  /**
   * Renders a page, category or notebook to PDF with headless Chrome. Needs a verified email
   * because it is by far the most expensive thing a user can ask the server to do.
   * Answers 503 `pdf_unavailable` when the server has no Chrome, so the web app can print locally.
   */
  @RequireVerified()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('pdf')
  async pdf(
    @CurrentUser() user: AuthUser,
    @Body({ schema: exportPdfSchema }) body: ExportPdfInput,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.exports.pdfFor(user.id, body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', attachment(filename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }

  /** One page as a .md file (a .zip when it has images/videos), or a folder tree as a .zip. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('markdown')
  async markdown(
    @CurrentUser() user: AuthUser,
    @Query({ schema: exportMarkdownQuerySchema }) q: z.infer<typeof exportMarkdownQuerySchema>,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.exports.markdownFor(user.id, q.scope, q.id);
    res.setHeader('Content-Disposition', attachment(result.filename));
    res.setHeader('Cache-Control', 'no-store');
    if (result.kind === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.end(result.text);
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    await result.write(res).catch(() => res.destroy());
  }
}
