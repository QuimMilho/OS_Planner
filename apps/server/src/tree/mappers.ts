import type { JSONContent } from '@tiptap/core';
import type { CategoryDto, NotebookDto, PageDto, PageMetaDto } from '@os-planner/shared';
import { fieldSeqDto } from '../common/merge-scope.js';
import type { Category, Notebook, Page } from '../generated/prisma/client.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toNotebookDto = (n: Notebook): NotebookDto => ({
  id: n.id,
  spaceId: n.spaceId,
  name: n.name,
  icon: n.icon,
  color: n.color,
  position: n.position,
  seq: Number(n.seq),
  ...fieldSeqDto(n.fieldSeq),
  deletedAt: iso(n.deletedAt),
  createdAt: n.createdAt.toISOString(),
  updatedAt: n.updatedAt.toISOString(),
});

export const toCategoryDto = (c: Category): CategoryDto => ({
  id: c.id,
  spaceId: c.spaceId,
  notebookId: c.notebookId,
  parentId: c.parentId,
  name: c.name,
  position: c.position,
  seq: Number(c.seq),
  ...fieldSeqDto(c.fieldSeq),
  deletedAt: iso(c.deletedAt),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

type PageMetaRow = Omit<Page, 'content' | 'contentText' | 'sizeBytes'> & Partial<Pick<Page, 'content' | 'contentText' | 'sizeBytes'>>;

export const toPageMetaDto = (p: PageMetaRow): PageMetaDto => ({
  id: p.id,
  spaceId: p.spaceId,
  notebookId: p.notebookId,
  categoryId: p.categoryId,
  title: p.title,
  position: p.position,
  version: p.version,
  seq: Number(p.seq),
  ...fieldSeqDto(p.fieldSeq),
  deletedAt: iso(p.deletedAt),
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const toPageDto = (p: Page): PageDto => ({
  ...toPageMetaDto(p),
  content: p.content as unknown as JSONContent,
  schemaVersion: p.schemaVersion,
});

/** Columns for page listings: everything except the (potentially large) document. */
export const PAGE_META_SELECT = {
  id: true,
  spaceId: true,
  userId: true,
  notebookId: true,
  categoryId: true,
  title: true,
  schemaVersion: true,
  version: true,
  position: true,
  seq: true,
  fieldSeq: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
