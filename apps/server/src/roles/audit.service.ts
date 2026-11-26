import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  hasPermission,
  Permission,
  type AuditEntryDto,
  type AuditPageDto,
  type AuditQuery,
} from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';
import type { InputJsonValue } from '../generated/prisma/internal/prismaNamespace.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { EventBus } from '../events/event-bus.js';
import { PermissionService } from '../spaces/permission.service.js';

const DAY = 24 * 60 * 60 * 1000;

export interface AuditRecord {
  teamId: string;
  /** Who did it; `null` for something the system did. */
  actorId: string | null;
  /** One of AUDIT_ACTIONS (shared). */
  action: string;
  targetKind: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Makes a value safe to store as JSON: bigints (permission sets) become decimal strings, dates ISO strings. */
const jsonSafe = (value: unknown): InputJsonValue | undefined =>
  value === undefined
    ? undefined
    : (JSON.parse(
        JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
      ) as InputJsonValue);

/**
 * The team's audit log: append-only, written in the same transaction as the change it describes (so a change that
 * rolls back leaves no row), read by whoever holds `VIEW_AUDIT_LOG`. There is no way to edit or delete a row except
 * the retention job, which removes rows older than `AUDIT_RETENTION_DAYS`.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly bus: EventBus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Records one entry inside the caller's transaction. */
  async record(tx: Tx, entry: AuditRecord): Promise<void> {
    await tx.auditLog.create({
      data: {
        teamId: entry.teamId,
        actorId: entry.actorId,
        action: entry.action,
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        before: jsonSafe(entry.before),
        after: jsonSafe(entry.after),
        reason: entry.reason?.slice(0, 500),
      },
    });
    // The same entry tells the realtime layer, once it is committed, that someone's access may have changed.
    this.bus.publishAfterCommit(tx, 'team.audited', {
      teamId: entry.teamId,
      action: entry.action,
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      actorId: entry.actorId,
      after: entry.after ?? null,
    });
  }

  /** Newest first. 404 for people outside the team, 403 for members without `VIEW_AUDIT_LOG`. */
  async list(userId: string, teamId: string, q: AuditQuery): Promise<AuditPageDto> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (!hasPermission(access.perms, Permission.VIEW_AUDIT_LOG))
      throw new ForbiddenException('forbidden');

    const rows = await this.prisma.auditLog.findMany({
      where: {
        teamId,
        ...(q.action && { action: q.action }),
        ...(q.actor && { actorId: q.actor }),
        ...((q.from || q.to) && {
          createdAt: {
            ...(q.from && { gte: new Date(q.from) }),
            ...(q.to && { lte: new Date(q.to) }),
          },
        }),
        ...(q.cursor && { id: { lt: BigInt(q.cursor) } }),
      },
      include: { actor: { select: { displayName: true } } },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const items: AuditEntryDto[] = page.map((r) => ({
      id: r.id.toString(10),
      teamId: r.teamId,
      actorId: r.actorId,
      actorName: r.actor?.displayName ?? null,
      action: r.action,
      targetKind: r.targetKind,
      targetId: r.targetId,
      before: r.before,
      after: r.after,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > q.limit ? page.at(-1)!.id.toString(10) : null };
  }

  /** Removes entries older than the retention period. Returns how many went. */
  async purge(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.env.AUDIT_RETENTION_DAYS * DAY);
    const res = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return res.count;
  }

  @Cron('20 3 * * *')
  async nightly(): Promise<void> {
    try {
      const n = await this.purge();
      if (n)
        this.log.log(
          `audit retention: removed ${n} entries older than ${this.env.AUDIT_RETENTION_DAYS} days`,
        );
    } catch (e) {
      this.log.error(`audit retention failed: ${e instanceof Error ? e.stack : e}`);
    }
  }
}
