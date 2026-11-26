import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AdminQuotaDto,
  QuotaDto,
  QuotaLimitsDto,
  QuotaOverrideDto,
  QuotaOverrideInput,
  QuotaScope,
  StorageBreakdownDto,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import type { QuotaOverride } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditService } from '../roles/audit.service.js';
import { QuotaExceeded } from './quota.errors.js';
import { QuotaPolicy } from './quota.policy.js';

type Db = PrismaService | Tx;

const toNumber = (v: bigint | null): number | null => (v === null ? null : Number(v));

const toOverrideDto = (o: QuotaOverride): QuotaOverrideDto => ({
  storageBytes: toNumber(o.storageBytes),
  maxMembers: o.maxMembers,
  maxProjects: o.maxProjects,
  maxFileBytes: toNumber(o.maxFileBytes),
  note: o.note,
  updatedBy: o.updatedBy,
  updatedAt: o.updatedAt.toISOString(),
});

/**
 * The one place that decides how much may be stored.
 *
 *  - `limitFor`        override, else the policy's default (the seam for plans and billing)
 *  - `usage`           bytes counted against a container
 *  - `assertCanStore`  cheap pre-check that fails fast before expensive work (moving a 500 MB video)
 *  - `charge`          the authoritative gate: an atomic compare-and-add inside the writing transaction
 *
 * Rules: an operation that stores bytes is refused entirely if it does not fit; a hard delete
 * (trash purge) refunds, a soft delete does not.
 */
@Injectable()
export class QuotaService {
  private readonly log = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: QuotaPolicy,
    private readonly audit: AuditService,
  ) {}

  /** The team an override belongs to, for the audit log: a team's own, or the team of a project. Personal ones have none. */
  private async teamOfScope(scope: QuotaScope, id: string): Promise<string | null> {
    if (scope === 'team') return id;
    if (scope === 'project') return (await this.prisma.project.findUnique({ where: { id }, select: { teamId: true } }))?.teamId ?? null;
    return null;
  }

  // ---------------------------------------------------------------- limits

  defaults(scope: QuotaScope): QuotaLimitsDto {
    return this.policy.defaults(scope);
  }

  async limitFor(scope: QuotaScope, id: string, db: Db = this.prisma): Promise<QuotaLimitsDto> {
    const override = await db.quotaOverride.findUnique({
      where: { scope_scopeId: { scope, scopeId: id } },
    });
    return this.merge(this.policy.defaults(scope), override);
  }

  private merge(defaults: QuotaLimitsDto, o: QuotaOverride | null): QuotaLimitsDto {
    if (!o) return defaults;
    return {
      storageBytes: o.storageBytes === null ? defaults.storageBytes : Number(o.storageBytes),
      maxMembers: o.maxMembers ?? defaults.maxMembers,
      maxProjects: o.maxProjects ?? defaults.maxProjects,
      maxFileBytes: o.maxFileBytes === null ? defaults.maxFileBytes : Number(o.maxFileBytes),
    };
  }

  // ---------------------------------------------------------------- usage

  async usage(scope: QuotaScope, id: string, db: Db = this.prisma): Promise<number> {
    const row = await this.counter(db, scope, id).read();
    if (row === null) throw new NotFoundException();
    return Number(row);
  }

  /** The person's own storage: used and the limit that applies to them. */
  async userQuota(userId: string, db: Db = this.prisma): Promise<QuotaDto> {
    return this.quotaOf('user', userId, db);
  }

  private async quotaOf(scope: QuotaScope, id: string, db: Db = this.prisma): Promise<QuotaDto> {
    const [used, limits] = await Promise.all([
      this.usage(scope, id, db),
      this.limitFor(scope, id, db),
    ]);
    return { scope, used, limit: limits.storageBytes };
  }

  async breakdown(scope: QuotaScope, id: string): Promise<StorageBreakdownDto> {
    const owner = { spaceId: { in: await this.spaceIds(scope, id) } };
    const [quota, media, docs, chat] = await Promise.all([
      this.quotaOf(scope, id),
      this.prisma.media.groupBy({ by: ['kind'], where: owner, _sum: { size: true } }),
      this.prisma.page.aggregate({ where: owner, _sum: { sizeBytes: true } }),
      // Chat text counts as documents too: heavy chatting cannot be unbounded.
      // (a person's direct messages are charged to them: they are not in any space)
      this.prisma.message.aggregate({
        where: scope === 'user' ? { OR: [{ channel: owner }, { authorId: id, channel: { kind: 'dm' } }] } : { channel: owner },
        _sum: { sizeBytes: true },
      }),
    ]);
    const sum = (kind: string) => media.find((m) => m.kind === kind)?._sum.size ?? 0;
    return {
      ...quota,
      images: sum('image'),
      video: sum('video'),
      documents: (docs._sum.sizeBytes ?? 0) + (chat._sum.sizeBytes ?? 0),
    };
  }

  // ---------------------------------------------------------------- checking and charging

  /** The same pre-check for whatever container owns a space (a project also has to fit in its team). */
  async assertCanStoreInSpace(spaceId: string, bytes: number, db: Db = this.prisma): Promise<void> {
    for (const target of await this.targets(spaceId, db))
      await this.assertCanStore(target.scope, target.id, bytes, db);
  }

  /** Largest single upload allowed in a space by an admin override (0 = only the instance limits apply). The strictest container wins. */
  async maxFileBytesForSpace(spaceId: string): Promise<number> {
    const caps: number[] = [];
    for (const target of await this.targets(spaceId, this.prisma)) {
      const { maxFileBytes } = await this.limitFor(target.scope, target.id);
      if (maxFileBytes > 0) caps.push(maxFileBytes);
    }
    return caps.length ? Math.min(...caps) : 0;
  }

  /** Throws `QuotaExceeded` if `bytes` more would not fit. Not atomic: `charge` is the real gate. */
  async assertCanStore(
    scope: QuotaScope,
    id: string,
    bytes: number,
    db: Db = this.prisma,
  ): Promise<void> {
    const [used, limits] = await Promise.all([
      this.usage(scope, id, db),
      this.limitFor(scope, id, db),
    ]);
    if (this.unlimited(scope, limits)) return;
    if (used + bytes > limits.storageBytes)
      throw new QuotaExceeded(scope, limits.storageBytes, used, bytes);
  }

  /**
   * Adds `delta` bytes (negative to refund) inside the writing transaction. For a positive delta
   * the update only matches while there is room, so two concurrent writers cannot both overshoot:
   *   UPDATE … SET used = used + ? WHERE id = ? AND used <= limit - ?
   */
  async charge(tx: Tx, scope: QuotaScope, id: string, delta: number): Promise<void> {
    if (delta === 0) return;
    const counter = this.counter(tx, scope, id);
    if (delta < 0) {
      await counter.refund(BigInt(-delta));
      return;
    }
    const limits = await this.limitFor(scope, id, tx);
    const cap = this.unlimited(scope, limits) ? null : BigInt(limits.storageBytes);
    if (!(await counter.add(BigInt(delta), cap))) {
      const used = await this.usage(scope, id, tx).catch(() => 0);
      throw new QuotaExceeded(scope, limits.storageBytes, used, delta);
    }
  }

  /**
   * Charges the container that owns a space, inside the writing transaction. Content of a project
   * counts against the project and, in the same transaction, against its team.
   */
  async chargeSpace(tx: Tx, spaceId: string, delta: number): Promise<void> {
    for (const target of await this.targets(spaceId, tx))
      await this.charge(tx, target.scope, target.id, delta);
  }

  /** The containers whose limits apply to content stored in a space: itself, and for a project also its team. */
  private async targets(spaceId: string, db: Db): Promise<{ scope: QuotaScope; id: string }[]> {
    const space = await db.space.findUnique({
      where: { id: spaceId },
      select: { kind: true, userId: true, teamId: true, projectId: true },
    });
    if (!space) throw new NotFoundException();
    if (space.kind === 'personal' && space.userId) return [{ scope: 'user', id: space.userId }];
    if (space.kind === 'team' && space.teamId) return [{ scope: 'team', id: space.teamId }];
    if (space.kind === 'project' && space.projectId) {
      const project = await db.project.findUnique({
        where: { id: space.projectId },
        select: { teamId: true },
      });
      if (!project) throw new NotFoundException();
      return [
        { scope: 'project', id: space.projectId },
        { scope: 'team', id: project.teamId },
      ];
    }
    throw new NotFoundException();
  }

  /** A project with limit 0 is bounded only by its team. */
  private unlimited(scope: QuotaScope, limits: QuotaLimitsDto): boolean {
    return scope === 'project' && limits.storageBytes === 0;
  }

  // ---------------------------------------------------------------- where the bytes are counted

  /** Spaces whose content counts toward a container: a team also counts its projects. */
  private async spaceIds(scope: QuotaScope, id: string): Promise<string[]> {
    const own = await this.prisma.space.findUnique({
      where: this.key(scope, id),
      select: { id: true },
    });
    if (!own) throw new NotFoundException();
    if (scope !== 'team') return [own.id];
    const projects = await this.prisma.space.findMany({
      where: { kind: 'project', project: { teamId: id } },
      select: { id: true },
    });
    return [own.id, ...projects.map((p) => p.id)];
  }

  private key(
    scope: QuotaScope,
    id: string,
  ): { userId: string } | { teamId: string } | { projectId: string } {
    return scope === 'user'
      ? { userId: id }
      : scope === 'team'
        ? { teamId: id }
        : { projectId: id };
  }

  private counter(db: Db, scope: QuotaScope, id: string) {
    const where = this.key(scope, id);
    return {
      read: async (): Promise<bigint | null> =>
        (await db.space.findUnique({ where, select: { storageUsedBytes: true } }))
          ?.storageUsedBytes ?? null,
      add: async (delta: bigint, cap: bigint | null): Promise<boolean> => {
        const res = await db.space.updateMany({
          where: { ...where, ...(cap === null ? {} : { storageUsedBytes: { lte: cap - delta } }) },
          data: { storageUsedBytes: { increment: delta } },
        });
        return res.count === 1;
      },
      refund: async (delta: bigint): Promise<void> => {
        const res = await db.space.updateMany({
          where: { ...where, storageUsedBytes: { gte: delta } },
          data: { storageUsedBytes: { decrement: delta } },
        });
        if (res.count === 0) await db.space.updateMany({ where, data: { storageUsedBytes: 0 } });
      },
    };
  }

  // ---------------------------------------------------------------- admin: overrides

  async adminView(scope: QuotaScope, id: string): Promise<AdminQuotaDto> {
    const [used, override] = await Promise.all([
      this.usage(scope, id),
      this.prisma.quotaOverride.findUnique({ where: { scope_scopeId: { scope, scopeId: id } } }),
    ]);
    const defaults = this.policy.defaults(scope);
    return {
      scope,
      id,
      used,
      defaults,
      override: override ? toOverrideDto(override) : null,
      effective: this.merge(defaults, override),
    };
  }

  async setOverride(
    scope: QuotaScope,
    id: string,
    input: QuotaOverrideInput,
    adminId: string,
  ): Promise<AdminQuotaDto> {
    await this.usage(scope, id); // 404 for something that does not exist
    const data = {
      storageBytes: input.storageBytes == null ? null : BigInt(input.storageBytes),
      maxMembers: input.maxMembers ?? null,
      maxProjects: input.maxProjects ?? null,
      maxFileBytes: input.maxFileBytes == null ? null : BigInt(input.maxFileBytes),
      note: input.note,
      updatedBy: adminId,
    };
    const teamId = await this.teamOfScope(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.quotaOverride.findUnique({ where: { scope_scopeId: { scope, scopeId: id } } });
      const row = await tx.quotaOverride.upsert({
        where: { scope_scopeId: { scope, scopeId: id } },
        create: { id: newId(), scope, scopeId: id, ...data },
        update: data,
      });
      if (teamId)
        await this.audit.record(tx, {
          teamId,
          actorId: adminId,
          action: 'quota.override',
          targetKind: scope,
          targetId: id,
          before: before ? toOverrideDto(before) : null,
          after: toOverrideDto(row),
        });
    });
    this.log.log(`quota override set by ${adminId}: ${scope}/${id} ${JSON.stringify(input)}`);
    return this.adminView(scope, id);
  }

  async clearOverride(scope: QuotaScope, id: string, adminId: string): Promise<AdminQuotaDto> {
    await this.usage(scope, id);
    const teamId = await this.teamOfScope(scope, id);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.quotaOverride.findUnique({ where: { scope_scopeId: { scope, scopeId: id } } });
      await tx.quotaOverride.deleteMany({ where: { scope, scopeId: id } });
      if (teamId && before)
        await this.audit.record(tx, {
          teamId,
          actorId: adminId,
          action: 'quota.override',
          targetKind: scope,
          targetId: id,
          before: toOverrideDto(before),
          after: null,
        });
    });
    this.log.log(`quota override cleared by ${adminId}: ${scope}/${id}`);
    return this.adminView(scope, id);
  }
}
