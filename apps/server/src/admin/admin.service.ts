import { Injectable } from '@nestjs/common';
import type { AdminStatsDto, AdminUsersPage } from '@os-planner/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';

/** Rows per page of the user list. Mutable only so tests can page without creating dozens of accounts. */
export const ADMIN_PAGE = { size: 50 };

/** Cursor = the last row's `createdAt|id`, so paging stays stable while accounts are added. */
const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
  ) {}

  async users(q: string | undefined, cursor: string | undefined): Promise<AdminUsersPage> {
    const after = decodeCursor(cursor);
    const where: Prisma.UserWhereInput = {
      ...(q ? { OR: [{ email: { contains: q } }, { displayName: { contains: q } }] } : {}),
      ...(after
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ADMIN_PAGE.size + 1,
    });
    const page = rows.slice(0, ADMIN_PAGE.size);
    const overrides = await this.prisma.quotaOverride.findMany({
      where: { scope: 'user', scopeId: { in: page.map((u) => u.id) } },
      select: { scopeId: true, storageBytes: true },
    });
    const byUser = new Map(overrides.map((o) => [o.scopeId, o]));
    const spaces = await this.prisma.space.findMany({
      where: { userId: { in: page.map((u) => u.id) } },
      select: { userId: true, storageUsedBytes: true },
    });
    const usedBy = new Map(spaces.map((s) => [s.userId, Number(s.storageUsedBytes)]));
    const defaultLimit = this.quota.defaults('user').storageBytes;

    return {
      items: page.map((u) => {
        const o = byUser.get(u.id);
        return {
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          emailVerified: u.emailVerifiedAt !== null,
          createdAt: u.createdAt.toISOString(),
          used: usedBy.get(u.id) ?? 0,
          limit: o?.storageBytes != null ? Number(o.storageBytes) : defaultLimit,
          hasOverride: !!o,
        };
      }),
      nextCursor:
        rows.length > ADMIN_PAGE.size
          ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
          : null,
    };
  }

  async stats(): Promise<AdminStatsDto> {
    const [users, verifiedUsers, storage] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
      // A team's counter already includes its projects, so projects are left out of the total.
      this.prisma.space.aggregate({
        where: { kind: { in: ['personal', 'team'] } },
        _sum: { storageUsedBytes: true },
      }),
    ]);
    const teams = await this.prisma.team.count({ where: { deletedAt: null } });
    return {
      users,
      verifiedUsers,
      storageBytes: Number(storage._sum.storageUsedBytes ?? 0),
      teams,
    };
  }
}
