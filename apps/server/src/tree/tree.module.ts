import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CategoriesService } from './categories.service.js';
import { NotebooksService } from './notebooks.service.js';
import { PagesService } from './pages.service.js';
import { SyncService } from './sync.service.js';
import { CategoriesController, NotebooksController, PagesController, SyncController } from './tree.controllers.js';
import { TreeErrorFilter } from './tree.error.js';

@Module({
  controllers: [NotebooksController, CategoriesController, PagesController, SyncController],
  providers: [
    NotebooksService,
    CategoriesService,
    PagesService,
    SyncService,
    { provide: APP_FILTER, useClass: TreeErrorFilter },
  ],
  exports: [NotebooksService, CategoriesService, PagesService],
})
export class TreeModule {}
