import { Injectable } from '@nestjs/common';
import { Permission, type CategoryDto, type CreateCategoryInput, type UpdateCategoryInput } from '@os-planner/shared';
import { changedKeys, guardDelete, guardUpdate } from '../common/merge-scope.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { toCategoryDto } from './mappers.js';
import { idTaken, invalid, notFound, parentDeleted } from './tree.error.js';

/** Categories can nest this deep (a root category is depth 1). */
export const MAX_CATEGORY_DEPTH = 8;

interface Node {
  id: string;
  parentId: string | null;
  deletedAt: Date | null;
}

/** Read-only view of a notebook's category forest, deleted ones included. */
class Forest {
  private readonly byId = new Map<string, Node>();
  private readonly children = new Map<string, string[]>();

  constructor(nodes: Node[]) {
    for (const n of nodes) {
      this.byId.set(n.id, n);
      if (n.parentId) (this.children.get(n.parentId) ?? this.children.set(n.parentId, []).get(n.parentId)!).push(n.id);
    }
  }

  get(id: string): Node | undefined {
    return this.byId.get(id);
  }

  /** Number of ancestors plus itself. */
  depth(id: string): number {
    let d = 0;
    for (let cur = this.byId.get(id); cur && d <= MAX_CATEGORY_DEPTH + 1; cur = cur.parentId ? this.byId.get(cur.parentId) : undefined) d++;
    return d;
  }

  /** Levels in the subtree rooted at `id` (a leaf is 1), counting only live categories. */
  height(id: string): number {
    const kids = (this.children.get(id) ?? []).filter((k) => !this.byId.get(k)!.deletedAt);
    return 1 + Math.max(0, ...kids.map((k) => this.height(k)));
  }

  /** `id` and everything below it. */
  subtree(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      stack.push(...(this.children.get(cur) ?? []));
    }
    return out;
  }

  isInSubtree(id: string, rootId: string): boolean {
    for (let cur = this.byId.get(id); cur; cur = cur.parentId ? this.byId.get(cur.parentId) : undefined) {
      if (cur.id === rootId) return true;
    }
    return false;
  }
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
  ) {}

  private async forest(tx: Tx, notebookId: string): Promise<Forest> {
    const rows = await tx.category.findMany({
      where: { notebookId },
      select: { id: true, parentId: true, deletedAt: true },
    });
    return new Forest(rows);
  }

  /** The space of an existing category after checking that the person may do `needed` there; null if it does not exist. */
  private async spaceOf(userId: string, id: string, needed: bigint): Promise<string | null> {
    const cat = await this.prisma.category.findUnique({ where: { id }, select: { spaceId: true, notebookId: true } });
    if (!cat) return null;
    await this.perms.requireNotebook(userId, cat.notebookId, needed);
    return cat.spaceId;
  }

  async create(userId: string, input: CreateCategoryInput): Promise<CategoryDto> {
    const inNotebook = await this.prisma.notebook.findUnique({ where: { id: input.notebookId }, select: { spaceId: true } });
    if (!inNotebook) throw notFound();
    const spaceId = inNotebook.spaceId;
    await this.perms.requireNotebook(userId, input.notebookId, Permission.EDIT_PAGES);

    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.category.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw idTaken();
        return toCategoryDto(existing);
      }

      const notebook = await tx.notebook.findFirst({ where: { id: input.notebookId, spaceId } });
      if (!notebook) throw notFound();
      if (notebook.deletedAt) throw parentDeleted();

      if (input.parentId) {
        const forest = await this.forest(tx, notebook.id);
        const parent = forest.get(input.parentId);
        if (!parent) throw notFound('parent category');
        if (parent.deletedAt) throw parentDeleted();
        if (forest.depth(parent.id) + 1 > MAX_CATEGORY_DEPTH) throw invalid(`categories can nest at most ${MAX_CATEGORY_DEPTH} levels`);
      }

      const row = await tx.category.create({
        data: {
          id: input.id,
          spaceId,
          userId,
          notebookId: notebook.id,
          parentId: input.parentId ?? null,
          name: input.name,
          position: input.position,
          seq,
        },
      });
      return toCategoryDto(row);
    });
  }

  async update(userId: string, id: string, patch: UpdateCategoryInput): Promise<CategoryDto> {
    const spaceId = await this.spaceOf(userId, id, Permission.EDIT_PAGES);
    if (!spaceId) throw notFound();
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.category.findFirst({ where: { id, spaceId, deletedAt: null } });
      if (!current) throw notFound();
      // Offline merge: only what nobody else changed since the device saw it (everything, for a plain request).
      const wanted = changedKeys(patch, current);
      const guard = wanted.size ? guardUpdate('category', current, wanted, patch, current) : null;
      const keys = guard?.keys ?? new Set<string>();

      if (keys.has('parentId') && patch.parentId !== undefined && patch.parentId !== current.parentId) {
        const forest = await this.forest(tx, current.notebookId);
        if (patch.parentId !== null) {
          const parent = forest.get(patch.parentId);
          if (!parent) throw notFound('parent category');
          if (parent.deletedAt) throw parentDeleted();
          if (forest.isInSubtree(parent.id, id)) throw invalid('a category cannot be moved into itself or its own subcategory');
          if (forest.depth(parent.id) + forest.height(id) > MAX_CATEGORY_DEPTH) {
            throw invalid(`categories can nest at most ${MAX_CATEGORY_DEPTH} levels`);
          }
        }
      }

      const row = await tx.category.update({
        where: { id },
        data: {
          ...(keys.has('name') && { name: patch.name }),
          ...(keys.has('parentId') && { parentId: patch.parentId }),
          ...(keys.has('position') && { position: patch.position }),
          ...(guard && { fieldSeq: guard.next(seq) }),
          seq,
        },
      });
      return toCategoryDto(row);
    });
  }

  /** Trashes the category, its subcategories and all their pages under one timestamp. */
  async remove(userId: string, id: string): Promise<void> {
    const spaceId = await this.spaceOf(userId, id, Permission.DELETE_PAGES);
    if (!spaceId) throw notFound(); // a second delete of what is in the trash is fine (it is still there)
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const cat = await tx.category.findFirst({ where: { id, spaceId } });
      if (!cat || !guardDelete(cat)) return;
      const ids = (await this.forest(tx, cat.notebookId)).subtree(id);
      const deletedAt = new Date();
      await tx.category.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt, seq } });
      await tx.page.updateMany({ where: { categoryId: { in: ids }, deletedAt: null }, data: { deletedAt, seq } });
    });
  }

  async restore(userId: string, id: string): Promise<CategoryDto> {
    const spaceId = await this.spaceOf(userId, id, Permission.DELETE_PAGES);
    if (!spaceId) throw notFound();
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const cat = await tx.category.findFirst({ where: { id, spaceId } });
      if (!cat) throw notFound();
      if (!cat.deletedAt) return toCategoryDto(cat);

      const notebook = await tx.notebook.findFirst({ where: { id: cat.notebookId } });
      if (!notebook || notebook.deletedAt) throw parentDeleted();
      const forest = await this.forest(tx, cat.notebookId);
      if (cat.parentId && forest.get(cat.parentId)?.deletedAt) throw parentDeleted();

      const stamp = cat.deletedAt;
      const ids = forest.subtree(id);
      await tx.category.updateMany({ where: { id: { in: ids }, deletedAt: stamp }, data: { deletedAt: null, seq } });
      await tx.page.updateMany({ where: { categoryId: { in: ids }, deletedAt: stamp }, data: { deletedAt: null, seq } });
      return toCategoryDto(await tx.category.findUniqueOrThrow({ where: { id } }));
    });
  }
}
