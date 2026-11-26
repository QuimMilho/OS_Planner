import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  createLinkSchema,
  idSchema,
  joinLinkSchema,
  linkSearchQuerySchema,
  linkTokenSchema,
  putShareSchema,
  resolveLinkSchema,
  updateLinkSchema,
  type CreateLinkInput,
  type JoinLinkInput,
  type LinkViewDto,
  type NotebookSharesDto,
  type PublicPageContentDto,
  type PublicSearchHitDto,
  type PutShareInput,
  type PutShareResult,
  type ResolveLinkInput,
  type ShareAccess,
  type ShareLinkDto,
  type SharedNotebookDto,
  type UpdateLinkInput,
} from '@os-planner/shared';
import { z } from 'zod';
import { CurrentUser, Public, RequireVerified, type AuthUser } from '../common/auth.decorators.js';
import { StorageService } from '../media/storage.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { LinksService } from './links.service.js';
import { SharesService } from './shares.service.js';

const Id = (name = 'id') => Param(name, { schema: idSchema });
const sessionQuery = z.object({ s: z.string().max(2000).optional() });
const noIndex = (res: Response): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
};

/** Sharing a notebook with people and by link: what the owner (or somebody who may share) does. */
@Controller()
export class SharingController {
  constructor(
    private readonly shares: SharesService,
    private readonly links: LinksService,
    private readonly perms: PermissionService,
  ) {}

  /** What the person may do in each team, project and shared notebook (see PermissionService.notebookPermissions). */
  @Get('notebook-permissions')
  notebookPermissions(@CurrentUser() u: AuthUser): Promise<Record<string, string>> {
    return this.perms.notebookPermissions(u.id);
  }

  @Get('notebooks/:id/shares')
  list(@CurrentUser() u: AuthUser, @Id() id: string): Promise<NotebookSharesDto> {
    return this.shares.list(u.id, id);
  }

  @Put('notebooks/:id/shares')
  put(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: putShareSchema }) body: PutShareInput,
  ): Promise<PutShareResult> {
    return this.shares.put(u.id, id, body);
  }

  @HttpCode(204)
  @Delete('notebooks/:id/shares/:shareId')
  remove(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Id('shareId') shareId: string,
  ): Promise<void> {
    return this.shares.remove(u.id, id, shareId);
  }

  @HttpCode(204)
  @Delete('notebooks/:id/pending-shares/:pendingId')
  removePending(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Id('pendingId') pendingId: string,
  ): Promise<void> {
    return this.shares.removePending(u.id, id, pendingId);
  }

  @Get('shared-with-me')
  sharedWithMe(@CurrentUser() u: AuthUser): Promise<SharedNotebookDto[]> {
    return this.shares.sharedWithMe(u.id);
  }

  @HttpCode(204)
  @Delete('shared-with-me/:notebookId')
  leave(@CurrentUser() u: AuthUser, @Id('notebookId') notebookId: string): Promise<void> {
    return this.shares.leave(u.id, notebookId);
  }

  // ---------------------------------------------------------------- links (owner side)

  @Get('notebooks/:id/links')
  listLinks(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ShareLinkDto[]> {
    return this.links.list(u.id, id);
  }

  @Post('notebooks/:id/links')
  createLink(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createLinkSchema }) body: CreateLinkInput,
  ): Promise<ShareLinkDto> {
    return this.links.create(u.id, id, body);
  }

  @Patch('links/:id')
  updateLink(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateLinkSchema }) body: UpdateLinkInput,
  ): Promise<ShareLinkDto> {
    return this.links.update(u.id, id, body);
  }

  @HttpCode(204)
  @Delete('links/:id')
  revokeLink(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.links.revoke(u.id, id);
  }

  // ---------------------------------------------------------------- an edit link used by a signed-in person

  /** Anonymous visitors get 401 from the global guard: editing needs a login. */
  @RequireVerified()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('links/join')
  join(
    @CurrentUser() u: AuthUser,
    @Body({ schema: joinLinkSchema }) body: JoinLinkInput,
    @Ip() ip: string,
  ): Promise<{ notebookId: string; access: ShareAccess }> {
    return this.links.join(u.id, body.token, ip, body.password);
  }
}

/**
 * What anybody who holds a link token may do. No login, no cookies, no user ids in any answer; each route repeats the
 * checks of the link (revoked, expired, password session) because nothing else is trusted between requests.
 */
@Controller('links')
export class PublicLinksController {
  constructor(
    private readonly links: LinksService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Post('resolve')
  resolve(
    @Body({ schema: resolveLinkSchema }) body: ResolveLinkInput,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LinkViewDto> {
    noIndex(res);
    return this.links.resolve(body.token, ip, body.password);
  }

  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Get(':token/pages/:pageId')
  page(
    @Param('token', { schema: linkTokenSchema }) token: string,
    @Id('pageId') pageId: string,
    @Query({ schema: sessionQuery }) q: z.infer<typeof sessionQuery>,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicPageContentDto> {
    noIndex(res);
    return this.links.page(token, ip, pageId, q.s);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get(':token/search')
  search(
    @Param('token', { schema: linkTokenSchema }) token: string,
    @Query({ schema: linkSearchQuerySchema }) q: z.infer<typeof linkSearchQuerySchema>,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicSearchHitDto[]> {
    noIndex(res);
    return this.links.search(token, ip, q.q, q.s);
  }

  /** Same file rules as /media/:id: data, never a document. Short caching: a revoked link must stop working soon. */
  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Get(':token/media/:mediaId')
  async media(
    @Param('token', { schema: linkTokenSchema }) token: string,
    @Id('mediaId') mediaId: string,
    @Query({ schema: sessionQuery }) q: z.infer<typeof sessionQuery>,
    @Ip() ip: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.links.media(token, ip, mediaId, q.s);
    res.type(file.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    await new Promise<void>((done) => {
      res.sendFile(
        this.storage.mediaPath(file.path.userId, file.path.id),
        { dotfiles: 'allow', acceptRanges: true },
        (err) => {
          if (err && !res.headersSent)
            res.status(404).json({ statusCode: 404, message: 'Not Found' });
          done();
        },
      );
    });
  }
}
