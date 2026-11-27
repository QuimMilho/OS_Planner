import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, MulterModule } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { diskStorage } from 'multer';
import { idSchema, mediaUploadFieldsSchema, type MediaDto, type MediaUploadFields } from '@os-planner/shared';
import { z } from 'zod';
import { CurrentUser, Public, RequireVerified, type AuthUser } from '../common/auth.decorators.js';
import { TokenService } from '../auth/token.service.js';
import { ENV, type Env } from '../config/env.js';
import { MediaService, type UploadedTempFile } from './media.service.js';
import { Authz } from '../common/authz.js';

const MB = 1024 * 1024;

/** Multer settings. Uploads stream to disk so a 500 MB video never sits in memory. */
export const multerOptions = {
  inject: [ENV],
  useFactory: (env: Env) => {
    const tmp = join(resolve(env.DATA_DIR), 'tmp');
    mkdirSync(tmp, { recursive: true });
    return {
      storage: diskStorage({ destination: tmp, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
      limits: { fileSize: Math.max(env.MAX_VIDEO_MB, env.MAX_IMAGE_MB) * MB, files: 1, fields: 8, fieldSize: 1024 },
    };
  },
};
export const MulterConfig = MulterModule.registerAsync(multerOptions);

const mediaQuery = z.object({ t: z.string().max(2000).optional() });

@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly tokens: TokenService,
  ) {}

  @RequireVerified()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Authz({ scope: 'self', verified: true, note: 'with notebookId: EDIT_PAGES in that notebook' })
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedTempFile | undefined,
    @Body({ schema: mediaUploadFieldsSchema }) fields: MediaUploadFields,
  ): Promise<MediaDto> {
    if (!file) throw new UnprocessableEntityException('file_required');
    return this.media.upload(user.id, file, fields);
  }

  /**
   * Streams the file. <img> and <video> cannot send an Authorization header, so a short-lived
   * media token may travel in the query string instead; a normal bearer token works too.
   * Range requests, conditional requests and caching are handled by Express's sendFile.
   */
  @Public()
  @Authz({ scope: 'own', note: 'bearer token or media token; files of every space the person can see, 404 for any other' })
  @Get(':id')
  async file(
    @Param('id', { schema: idSchema }) id: string,
    @Query({ schema: mediaQuery }) query: z.infer<typeof mediaQuery>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const userId = await this.resolveUser(req, query.t);
    const row = await this.media.accessible(userId, id);

    res.type(row.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    // Uploaded files are data, never documents: forbid any script or navigation if opened directly.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    await new Promise<void>((done) => {
      res.sendFile(this.media.filePath(row), { dotfiles: 'allow', acceptRanges: true }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ statusCode: 404, message: 'Not Found' });
        done();
      });
    });
  }

  private async resolveUser(req: Request, mediaToken: string | undefined): Promise<string> {
    if (mediaToken) {
      const id = await this.tokens.verifyMedia(mediaToken);
      if (id) return id;
    }
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const user = await this.tokens.verifyAccess(header.slice(7).trim());
      if (user) return user.id;
    }
    throw new UnauthorizedException('invalid_or_expired_token');
  }
}
