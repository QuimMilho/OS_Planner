import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { idSchema, replaceContentSchema, type PageSnapshotDto, type ReplaceContentInput, type ReplaceContentOk } from '@os-planner/shared';
import type { JSONContent } from '@tiptap/core';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { SnapshotsService } from './snapshots.service.js';
import { Authz } from '../common/authz.js';

const PageId = () => Param('pageId', { schema: idSchema });
const SnapshotId = () => Param('snapshotId', { schema: idSchema });

@Controller('pages/:pageId/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'] })
  @Get()
  list(@CurrentUser() u: AuthUser, @PageId() pageId: string): Promise<PageSnapshotDto[]> {
    return this.snapshots.list(u.id, pageId);
  }

  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'] })
  @Get(':snapshotId')
  preview(
    @CurrentUser() u: AuthUser,
    @PageId() pageId: string,
    @SnapshotId() snapshotId: string,
  ): Promise<{ content: JSONContent }> {
    return this.snapshots.preview(u.id, pageId, snapshotId);
  }

  /** A text a device kept becomes the page's text (Local history "Replace", a copy it made, a page from before co-editing): see SnapshotsService.replaceContent. */
  @HttpCode(200)
  @Authz({ scope: 'notebook', needs: ['EDIT_PAGES'] })
  @Post('replace')
  replace(
    @CurrentUser() u: AuthUser,
    @PageId() pageId: string,
    @Body({ schema: replaceContentSchema }) body: ReplaceContentInput,
  ): Promise<ReplaceContentOk> {
    return this.snapshots.replaceContent(u.id, pageId, body);
  }

  @HttpCode(200)
  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'] })
  @Post(':snapshotId/restore')
  async restore(
    @CurrentUser() u: AuthUser,
    @PageId() pageId: string,
    @SnapshotId() snapshotId: string,
  ): Promise<{ ok: true }> {
    await this.snapshots.restore(u.id, pageId, snapshotId);
    return { ok: true };
  }
}
