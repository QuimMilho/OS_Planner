import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCategorySchema,
  createNotebookSchema,
  createPageSchema,
  idSchema,
  moveNotebookSchema,
  syncBatchSchema,
  syncChangesQuerySchema,
  updateCategorySchema,
  updateNotebookSchema,
  updatePageSchema,
  type CategoryDto,
  type CreateCategoryInput,
  type CreateNotebookInput,
  type CreatePageInput,
  type MoveNotebookInput,
  type NotebookDto,
  type PageDto,
  type PageMetaDto,
  type SyncBatchInput,
  type SyncBatchResponse,
  type SyncChangesDto,
  type UpdateCategoryInput,
  type UpdateNotebookInput,
  type UpdatePageInput,
} from '@os-planner/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { CategoriesService } from './categories.service.js';
import { NotebooksService } from './notebooks.service.js';
import { PagesService } from './pages.service.js';
import { SyncService } from './sync.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });

@Controller('notebooks')
export class NotebooksController {
  constructor(private readonly notebooks: NotebooksService) {}

  /** The person's own notebooks (or those of another space they can see, with ?spaceId=). */
  @Authz({ scope: 'self', note: 'with spaceId: a space the person can see' })
  @Get()
  list(@CurrentUser() u: AuthUser, @Query({ schema: z.object({ spaceId: idSchema.optional() }) }) q: { spaceId?: string }): Promise<NotebookDto[]> {
    return this.notebooks.list(u.id, q.spaceId);
  }

  @Authz({ scope: 'notebook' })
  @Get(':id/tree')
  tree(@CurrentUser() u: AuthUser, @Id() id: string) {
    return this.notebooks.tree(u.id, id);
  }

  /** REST callers get a default "General" category; sync clients create their own. */
  @Authz({ scope: 'self', note: 'in another space (spaceId): CREATE_NOTEBOOKS there' })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body({ schema: createNotebookSchema }) body: CreateNotebookInput): Promise<NotebookDto> {
    return this.notebooks.create(u.id, body, true);
  }

  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'] })
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateNotebookSchema }) body: UpdateNotebookInput,
  ): Promise<NotebookDto> {
    return this.notebooks.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'] })
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.notebooks.remove(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'] })
  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<NotebookDto> {
    return this.notebooks.restore(u.id, id);
  }

  /** To another space (personal, team or project): see NotebooksService.move. */
  @HttpCode(200)
  @Authz({ scope: 'notebook', needs: ['MANAGE_NOTEBOOKS'], note: 'CREATE_NOTEBOOKS in the destination' })
  @Post(':id/move')
  move(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: moveNotebookSchema }) body: MoveNotebookInput): Promise<NotebookDto> {
    return this.notebooks.move(u.id, id, body.spaceId);
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Authz({ scope: 'notebook', needs: ['EDIT_PAGES'], note: 'the notebook is in the body' })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body({ schema: createCategorySchema }) body: CreateCategoryInput): Promise<CategoryDto> {
    return this.categories.create(u.id, body);
  }

  @Authz({ scope: 'notebook', needs: ['EDIT_PAGES'] })
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateCategorySchema }) body: UpdateCategoryInput,
  ): Promise<CategoryDto> {
    return this.categories.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'notebook', needs: ['DELETE_PAGES'] })
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.categories.remove(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'notebook', needs: ['DELETE_PAGES'] })
  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<CategoryDto> {
    return this.categories.restore(u.id, id);
  }
}

const pageListQuerySchema = z.object({ categoryId: idSchema.optional(), notebookId: idSchema.optional() });

@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Authz({ scope: 'notebook', note: 'the pages of the notebook or category in the query' })
  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query({ schema: pageListQuerySchema }) q: z.infer<typeof pageListQuerySchema>,
  ): Promise<PageMetaDto[]> {
    return this.pages.list(u.id, q);
  }

  @Authz({ scope: 'notebook' })
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Id() id: string): Promise<PageDto> {
    return this.pages.get(u.id, id);
  }

  @Authz({ scope: 'notebook', needs: ['EDIT_PAGES'], note: 'the category is in the body' })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body({ schema: createPageSchema }) body: CreatePageInput): Promise<PageMetaDto> {
    return this.pages.create(u.id, body);
  }

  @Authz({ scope: 'notebook', needs: ['EDIT_PAGES'] })
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updatePageSchema }) body: UpdatePageInput,
  ): Promise<PageMetaDto> {
    return this.pages.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'notebook', needs: ['DELETE_PAGES'] })
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    return this.pages.remove(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'notebook', needs: ['DELETE_PAGES'] })
  @Post(':id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<PageMetaDto> {
    return this.pages.restore(u.id, id);
  }
}

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Authz({ scope: 'self' })
  @Get('changes')
  changes(
    @CurrentUser() u: AuthUser,
    @Query({ schema: syncChangesQuerySchema }) q: z.infer<typeof syncChangesQuerySchema>,
  ): Promise<SyncChangesDto> {
    return this.sync.changes(u.id, q);
  }

  @HttpCode(200)
  @Authz({ scope: 'self', note: 'each operation is checked like its REST route' })
  @Post('batch')
  batch(@CurrentUser() u: AuthUser, @Body({ schema: syncBatchSchema }) body: SyncBatchInput): Promise<SyncBatchResponse> {
    return this.sync.batch(u.id, body.ops);
  }
}

@Controller('spaces')
export class SpacesController {
  constructor(private readonly notebooks: NotebooksService) {}

  /** Notebooks of a personal, team or project space the person can see (404 for anything else). */
  @Authz({ scope: 'notebook', note: 'the notebooks of a space the person can see' })
  @Get(':id/notebooks')
  list(@CurrentUser() u: AuthUser, @Id() id: string): Promise<NotebookDto[]> {
    return this.notebooks.list(u.id, id);
  }
}
