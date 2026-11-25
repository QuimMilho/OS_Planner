import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  createCategorySchema,
  createNotebookSchema,
  createPageSchema,
  idSchema,
  putContentSchema,
  syncBatchSchema,
  syncChangesQuerySchema,
  updateCategorySchema,
  updateNotebookSchema,
  updatePageSchema,
  type CategoryDto,
  type CreateCategoryInput,
  type CreateNotebookInput,
  type CreatePageInput,
  type NotebookDto,
  type PageDto,
  type PageMetaDto,
  type PutContentInput,
  type PutContentOk,
  type SyncBatchInput,
  type SyncBatchResponse,
  type SyncChangesDto,
  type UpdateCategoryInput,
  type UpdateNotebookInput,
  type UpdatePageInput,
} from '@notes/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { CategoriesService } from './categories.service.js';
import { NotebooksService } from './notebooks.service.js';
import { PagesService } from './pages.service.js';
import { SyncService } from './sync.service.js';

const Id = () => Param('id', { schema: idSchema });

@Controller('notebooks')
export class NotebooksController {
  constructor(private readonly notebooks: NotebooksService) {}

  @Get()
  list(@CurrentUser() u: AuthUser): Promise<NotebookDto[]> {
    return this.notebooks.list(u.id);
  }

  @Get(':id/tree')
  tree(@CurrentUser() u: AuthUser, @Id() id: string) {
    return this.notebooks.tree(u.id, id);
  }

  /** REST callers get a default "General" category; sync clients create their own. */
  @Post()
  create(@CurrentUser() u: AuthUser, @Body({ schema: createNotebookSchema }) body: CreateNotebookInput): Promise<NotebookDto> {
    return this.notebooks.create(u.id, body, true);
  }

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateNotebookSchema }) body: UpdateNotebookInput,
  ): Promise<NotebookDto> {
    return this.notebooks.update(u.id, id, body);
  }

  @HttpCode(204)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.notebooks.remove(u.id, id);
  }

  @HttpCode(200)
  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<NotebookDto> {
    return this.notebooks.restore(u.id, id);
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body({ schema: createCategorySchema }) body: CreateCategoryInput): Promise<CategoryDto> {
    return this.categories.create(u.id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateCategorySchema }) body: UpdateCategoryInput,
  ): Promise<CategoryDto> {
    return this.categories.update(u.id, id, body);
  }

  @HttpCode(204)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.categories.remove(u.id, id);
  }

  @HttpCode(200)
  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<CategoryDto> {
    return this.categories.restore(u.id, id);
  }
}

const pageListQuerySchema = z.object({ categoryId: idSchema.optional(), notebookId: idSchema.optional() });

@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query({ schema: pageListQuerySchema }) q: z.infer<typeof pageListQuerySchema>,
  ): Promise<PageMetaDto[]> {
    return this.pages.list(u.id, q);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Id() id: string): Promise<PageDto> {
    return this.pages.get(u.id, id);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body({ schema: createPageSchema }) body: CreatePageInput): Promise<PageMetaDto> {
    return this.pages.create(u.id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updatePageSchema }) body: UpdatePageInput,
  ): Promise<PageMetaDto> {
    return this.pages.update(u.id, id, body);
  }

  @Put(':id/content')
  putContent(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: putContentSchema }) body: PutContentInput,
  ): Promise<PutContentOk> {
    return this.pages.putContent(u.id, id, body);
  }

  @HttpCode(204)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.pages.remove(u.id, id);
  }

  @HttpCode(200)
  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<PageMetaDto> {
    return this.pages.restore(u.id, id);
  }
}

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('changes')
  changes(
    @CurrentUser() u: AuthUser,
    @Query({ schema: syncChangesQuerySchema }) q: z.infer<typeof syncChangesQuerySchema>,
  ): Promise<SyncChangesDto> {
    return this.sync.changes(u.id, q.since);
  }

  @HttpCode(200)
  @Post('batch')
  batch(@CurrentUser() u: AuthUser, @Body({ schema: syncBatchSchema }) body: SyncBatchInput): Promise<SyncBatchResponse> {
    return this.sync.batch(u.id, body.ops);
  }
}
