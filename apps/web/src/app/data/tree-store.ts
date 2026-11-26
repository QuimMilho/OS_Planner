import { Injectable, computed, inject } from '@angular/core';
import { EMPTY_DOC, positionBetween } from '@os-planner/shared/lite';
import type { CategoryDto, NotebookDto, PageMetaDto } from '@os-planner/shared';
import { AuthStore } from '../core/auth-store';
import { Language } from '../core/i18n';
import { uuidv7 } from '../core/ids';
import { Db, type PlannerDb } from './db';
import { liveSignal } from './live';
import { Outbox } from './outbox';

export interface CategoryNode {
  category: CategoryDto;
  pages: PageMetaDto[];
  children: CategoryNode[];
}
export interface NotebookNode {
  notebook: NotebookDto;
  roots: CategoryNode[];
  pageCount: number;
}
export type TrashItem =
  | { kind: 'notebook'; item: NotebookDto }
  | { kind: 'category'; item: CategoryDto }
  | { kind: 'page'; item: PageMetaDto };

/** Binary string comparison: fractional-index keys are case-sensitive. */
export const byPosition = <T extends { position: string }>(a: T, b: T): number =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

const now = () => new Date().toISOString();

/**
 * The notebook → category → page hierarchy as the UI sees it. Reads come from the local
 * database (so everything works offline); every change is applied there at once and queued
 * for the server. The server applies the same cascade rules, so both sides agree.
 */
@Injectable({ providedIn: 'root' })
export class TreeStore {
  private readonly dbs = inject(Db);
  private readonly outbox = inject(Outbox);
  private readonly lang = inject(Language);
  private readonly auth = inject(AuthStore);

  /** The account's own space. Rows stored before spaces existed carry none and are personal. */
  readonly personalSpaceId = computed(() => this.auth.user()?.personalSpaceId ?? '');
  isPersonal(row: { spaceId?: string }): boolean {
    return !row.spaceId || row.spaceId === this.personalSpaceId();
  }

  readonly notebooks = liveSignal(this.dbs, (d) => d.notebooks.toArray(), [] as NotebookDto[]);
  readonly categories = liveSignal(this.dbs, (d) => d.categories.toArray(), [] as CategoryDto[]);
  readonly pages = liveSignal(this.dbs, (d) => d.pages.toArray(), [] as PageMetaDto[]);

  readonly pageById = computed(() => new Map(this.pages().map((p) => [p.id, p])));
  readonly categoryById = computed(() => new Map(this.categories().map((c) => [c.id, c])));
  readonly notebookById = computed(() => new Map(this.notebooks().map((n) => [n.id, n])));

  /** Live (not trashed) notebooks with their nested categories and pages, in position order. */
  readonly tree = computed<NotebookNode[]>(() => {
    const cats = this.categories().filter((c) => !c.deletedAt && this.isPersonal(c));
    const pages = this.pages().filter((p) => !p.deletedAt && this.isPersonal(p));
    const nodes = new Map<string, CategoryNode>(cats.map((c) => [c.id, { category: c, pages: [], children: [] }]));
    for (const p of [...pages].sort(byPosition)) nodes.get(p.categoryId)?.pages.push(p);

    const rootsByNotebook = new Map<string, CategoryNode[]>();
    for (const c of [...cats].sort(byPosition)) {
      const node = nodes.get(c.id)!;
      const parent = c.parentId ? nodes.get(c.parentId) : undefined;
      if (parent) parent.children.push(node);
      else (rootsByNotebook.get(c.notebookId) ?? rootsByNotebook.set(c.notebookId, []).get(c.notebookId)!).push(node);
    }
    return this.notebooks()
      .filter((n) => !n.deletedAt && this.isPersonal(n))
      .sort(byPosition)
      .map((n) => ({
        notebook: n,
        roots: rootsByNotebook.get(n.id) ?? [],
        pageCount: pages.filter((p) => p.notebookId === n.id).length,
      }));
  });

  /** Items in the trash that were deleted on their own (not merely as part of a trashed parent). */
  readonly trash = computed<TrashItem[]>(() => {
    const nbs = this.notebookById();
    const cats = this.categoryById();
    const out: TrashItem[] = [];
    for (const n of this.notebooks()) if (n.deletedAt && this.isPersonal(n)) out.push({ kind: 'notebook', item: n });
    for (const c of this.categories()) {
      if (!c.deletedAt || !this.isPersonal(c)) continue;
      const parent = c.parentId ? cats.get(c.parentId) : undefined;
      const nb = nbs.get(c.notebookId);
      if (nb?.deletedAt === c.deletedAt || parent?.deletedAt === c.deletedAt) continue;
      out.push({ kind: 'category', item: c });
    }
    for (const p of this.pages()) {
      if (!p.deletedAt || !this.isPersonal(p)) continue;
      const cat = cats.get(p.categoryId);
      if (cat?.deletedAt === p.deletedAt || nbs.get(p.notebookId)?.deletedAt === p.deletedAt) continue;
      out.push({ kind: 'page', item: p });
    }
    return out.sort((a, b) => (b.item.deletedAt ?? '').localeCompare(a.item.deletedAt ?? ''));
  });

  // ------------------------------------------------------------------ helpers

  private async lastPosition(rows: { position: string }[]): Promise<string> {
    const last = rows.sort(byPosition).at(-1)?.position ?? null;
    return positionBetween(last, null);
  }

  private subtreeIds(all: { id: string; parentId: string | null }[], rootId: string): Set<string> {
    const ids = new Set([rootId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of all) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) ids.add(c.id), (grew = true);
    }
    return ids;
  }

  // ------------------------------------------------------------------ notebooks

  async createNotebook(name: string): Promise<NotebookDto> {
    const db = this.dbs.db;
    const id = uuidv7();
    const categoryId = uuidv7();
    const stamp = now();
    const position = await this.lastPosition(await db.notebooks.filter((n) => !n.deletedAt).toArray());
    const spaceId = this.personalSpaceId();
    const notebook: NotebookDto = { id, spaceId, name, icon: null, color: null, position, seq: 0, deletedAt: null, createdAt: stamp, updatedAt: stamp };
    const category: CategoryDto = {
      id: categoryId,
      spaceId,
      notebookId: id,
      parentId: null,
      name: this.lang.t('tree.defaultCategory'),
      position: positionBetween(null, null),
      seq: 0,
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await db.transaction('rw', db.notebooks, db.categories, async () => {
      await db.notebooks.add(notebook);
      await db.categories.add(category);
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'notebook.create', id, name, icon: null, color: null, position });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'category.create', id: categoryId, notebookId: id, parentId: null, name: category.name, position: category.position });
    return notebook;
  }

  async updateNotebook(id: string, patch: { name?: string; icon?: string | null; color?: string | null }): Promise<void> {
    await this.dbs.db.notebooks.update(id, { ...patch, updatedAt: now() });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'notebook.update', id, ...patch });
  }

  async deleteNotebook(id: string): Promise<void> {
    const db = this.dbs.db;
    const stamp = now();
    await db.transaction('rw', db.notebooks, db.categories, db.pages, async () => {
      await db.notebooks.where('id').equals(id).filter((n) => !n.deletedAt).modify({ deletedAt: stamp });
      await db.categories.where('notebookId').equals(id).filter((c) => !c.deletedAt).modify({ deletedAt: stamp });
      await db.pages.where('notebookId').equals(id).filter((p) => !p.deletedAt).modify({ deletedAt: stamp });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'notebook.delete', id });
  }

  async restoreNotebook(id: string): Promise<void> {
    const db = this.dbs.db;
    await db.transaction('rw', db.notebooks, db.categories, db.pages, async () => {
      const nb = await db.notebooks.get(id);
      if (!nb?.deletedAt) return;
      const stamp = nb.deletedAt;
      await db.notebooks.update(id, { deletedAt: null });
      await db.categories.where('notebookId').equals(id).filter((c) => c.deletedAt === stamp).modify({ deletedAt: null });
      await db.pages.where('notebookId').equals(id).filter((p) => p.deletedAt === stamp).modify({ deletedAt: null });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'notebook.restore', id });
  }

  // ------------------------------------------------------------------ categories

  async createCategory(notebookId: string, parentId: string | null, name: string): Promise<CategoryDto> {
    const db = this.dbs.db;
    const id = uuidv7();
    const stamp = now();
    const siblings = await db.categories.where('notebookId').equals(notebookId).filter((c) => !c.deletedAt && c.parentId === parentId).toArray();
    const position = await this.lastPosition(siblings);
    const spaceId = (await db.notebooks.get(notebookId))?.spaceId ?? this.personalSpaceId();
    const category: CategoryDto = { id, spaceId, notebookId, parentId, name, position, seq: 0, deletedAt: null, createdAt: stamp, updatedAt: stamp };
    await db.categories.add(category);
    await this.outbox.enqueue({ opId: uuidv7(), type: 'category.create', id, notebookId, parentId, name, position });
    return category;
  }

  async updateCategory(id: string, patch: { name?: string; parentId?: string | null; position?: string }): Promise<void> {
    await this.dbs.db.categories.update(id, { ...patch, updatedAt: now() });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'category.update', id, ...patch });
  }

  async deleteCategory(id: string): Promise<void> {
    const db = this.dbs.db;
    const stamp = now();
    await db.transaction('rw', db.categories, db.pages, async () => {
      const cat = await db.categories.get(id);
      if (!cat || cat.deletedAt) return;
      const ids = this.subtreeIds(await db.categories.where('notebookId').equals(cat.notebookId).toArray(), id);
      await db.categories.where('id').anyOf([...ids]).filter((c) => !c.deletedAt).modify({ deletedAt: stamp });
      await db.pages.where('categoryId').anyOf([...ids]).filter((p) => !p.deletedAt).modify({ deletedAt: stamp });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'category.delete', id });
  }

  /**
   * Restoring something whose folder or notebook is also in the trash brings those back first
   * (outermost first), otherwise it would be restored into a place that is not visible.
   */
  private async reviveAncestors(notebookId: string, categoryId: string | null): Promise<void> {
    const db = this.dbs.db;
    if ((await db.notebooks.get(notebookId))?.deletedAt) await this.restoreNotebook(notebookId);
    const chain: string[] = [];
    for (let id = categoryId; id; ) {
      const c = await db.categories.get(id);
      if (!c) break;
      if (c.deletedAt) chain.push(id);
      id = c.parentId;
    }
    for (const id of chain.reverse()) await this.restoreCategory(id, false);
  }

  async restoreCategory(id: string, reviveParents = true): Promise<void> {
    const db = this.dbs.db;
    const target = await db.categories.get(id);
    if (reviveParents && target) await this.reviveAncestors(target.notebookId, target.parentId);
    await db.transaction('rw', db.categories, db.pages, async () => {
      const cat = await db.categories.get(id);
      if (!cat?.deletedAt) return;
      const stamp = cat.deletedAt;
      const ids = this.subtreeIds(await db.categories.where('notebookId').equals(cat.notebookId).toArray(), id);
      await db.categories.where('id').anyOf([...ids]).filter((c) => c.deletedAt === stamp).modify({ deletedAt: null });
      await db.pages.where('categoryId').anyOf([...ids]).filter((p) => p.deletedAt === stamp).modify({ deletedAt: null });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'category.restore', id });
  }

  // ------------------------------------------------------------------ pages

  async createPage(categoryId: string, title = ''): Promise<PageMetaDto> {
    const db = this.dbs.db;
    const category = await db.categories.get(categoryId);
    if (!category) throw new Error('category not found');
    const id = uuidv7();
    const stamp = now();
    const siblings = await db.pages.where('categoryId').equals(categoryId).filter((p) => !p.deletedAt).toArray();
    const position = await this.lastPosition(siblings);
    const page: PageMetaDto = { id, spaceId: category.spaceId ?? this.personalSpaceId(), notebookId: category.notebookId, categoryId, title, position, version: 0, seq: 0, deletedAt: null, createdAt: stamp, updatedAt: stamp };
    await db.transaction('rw', db.pages, db.contents, async () => {
      await db.pages.add(page);
      await db.contents.add({ id, content: structuredClone(EMPTY_DOC) as never, baseVersion: 0, dirty: 0, rev: 0 });
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'page.create', id, categoryId, title, position });
    return page;
  }

  async renamePage(id: string, title: string): Promise<void> {
    await this.dbs.db.pages.update(id, { title, updatedAt: now() });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'page.update', id, title });
  }

  async movePage(id: string, categoryId: string, position?: string): Promise<void> {
    const db = this.dbs.db;
    const category = await db.categories.get(categoryId);
    if (!category) return;
    const pos = position ?? (await this.lastPosition(await db.pages.where('categoryId').equals(categoryId).filter((p) => !p.deletedAt && p.id !== id).toArray()));
    await db.pages.update(id, { categoryId, notebookId: category.notebookId, position: pos, updatedAt: now() });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'page.update', id, categoryId, position: pos });
  }

  async deletePage(id: string): Promise<void> {
    await this.dbs.db.pages.where('id').equals(id).filter((p) => !p.deletedAt).modify({ deletedAt: now() });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'page.delete', id });
  }

  async restorePage(id: string): Promise<void> {
    const page = await this.dbs.db.pages.get(id);
    if (page) await this.reviveAncestors(page.notebookId, page.categoryId);
    await this.dbs.db.pages.update(id, { deletedAt: null });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'page.restore', id });
  }

  /** Swaps the position of two siblings (used by "move up / move down"). */
  async swapPositions(kind: 'category' | 'page' | 'notebook', a: { id: string; position: string }, b: { id: string; position: string }): Promise<void> {
    const db: PlannerDb = this.dbs.db;
    const table = kind === 'notebook' ? db.notebooks : kind === 'category' ? db.categories : db.pages;
    await table.update(a.id, { position: b.position } as never);
    await table.update(b.id, { position: a.position } as never);
    const type = `${kind}.update` as const;
    await this.outbox.enqueue({ opId: uuidv7(), type, id: a.id, position: b.position } as never);
    await this.outbox.enqueue({ opId: uuidv7(), type, id: b.id, position: a.position } as never);
  }
}
