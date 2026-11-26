import { Injectable } from '@nestjs/common';
import type { SearchResultDto } from '@os-planner/shared';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { buildSnippet, parseSearchQuery, titleHits } from './query.js';

interface Row {
  id: string;
  spaceId: string;
  title: string;
  notebookId: string;
  notebookName: string;
  categoryId: string;
  categoryName: string;
  contentText: string;
  updatedAt: Date;
  score: number;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  async search(userId: string, q: string, limit: number, notebookId?: string): Promise<SearchResultDto[]> {
    const query = parseSearchQuery(q);
    if (!query.boolean) return [];

    // Everything the person can read: their own notes plus the notebooks of the teams and projects they belong to.
    const spaceIds = [...(await this.perms.notebookSpaces(userId)).keys()];
    if (!spaceIds.length) return [];

    // Over-fetch, then re-rank so pages whose *title* matches come first.
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT p.id, p.spaceId, p.title, p.notebookId, n.name AS notebookName, p.categoryId, c.name AS categoryName,
             p.contentText, p.updatedAt,
             MATCH(p.title, p.contentText) AGAINST (${query.boolean} IN BOOLEAN MODE) AS score
      FROM Page p
      JOIN Notebook n ON n.id = p.notebookId
      JOIN Category c ON c.id = p.categoryId
      WHERE p.spaceId IN (${Prisma.join(spaceIds)})
        AND p.deletedAt IS NULL AND n.deletedAt IS NULL AND c.deletedAt IS NULL
        AND MATCH(p.title, p.contentText) AGAINST (${query.boolean} IN BOOLEAN MODE)
        ${notebookId ? Prisma.sql`AND p.notebookId = ${notebookId}` : Prisma.empty}
      ORDER BY score DESC
      LIMIT ${limit * 3}
    `);

    return rows
      .map((r) => ({ r, rank: Number(r.score) + titleHits(r.title, query) * 2 }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map(({ r, rank }) => ({
        pageId: r.id,
        spaceId: r.spaceId,
        title: r.title,
        notebookId: r.notebookId,
        notebookName: r.notebookName,
        categoryId: r.categoryId,
        categoryName: r.categoryName,
        snippet: buildSnippet(r.contentText, query),
        score: rank,
        updatedAt: r.updatedAt.toISOString(),
      }));
  }
}
