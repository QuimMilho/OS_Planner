import { Injectable } from '@nestjs/common';
import { BOARD_EVENTS, Permission, type CreateLabelInput, type LabelDto, type UpdateLabelInput } from '@os-planner/shared';
import { BOARD_LIMITS } from '@os-planner/shared/boards';
import { ConflictException } from '@nestjs/common';
import type { Label } from '../generated/prisma/client.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PermissionService, chainIdsOf } from '../spaces/permission.service.js';
import { idTaken, invalid, notFound } from '../tree/tree.error.js';
import { BoardEvents } from './board-events.js';
import { toLabelDto } from './board-views.js';

type Db = PrismaService | Tx;

/**
 * Labels of a team, a project or a personal space. A team's inheritable labels are also usable in its projects, and a project's in
 * its sub-projects (never the other way up). Deleting a label takes it off every task that wears it, in whichever space that task is.
 */
@Injectable()
export class LabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
    private readonly events: BoardEvents,
  ) {}

  /** The spaces above this one (a project's parents, then its team), nearest first: where inheritable labels come from. */
  private async ancestorSpaces(db: Db, spaceId: string): Promise<string[]> {
    const space = await db.space.findUnique({ where: { id: spaceId }, select: { kind: true, projectId: true } });
    if (space?.kind !== 'project' || !space.projectId) return [];
    const project = await db.project.findUnique({ where: { id: space.projectId }, select: { path: true, teamId: true } });
    if (!project) return [];
    const above = chainIdsOf(project.path).slice(0, -1).reverse();
    const parents = above.length ? await db.project.findMany({ where: { id: { in: above } }, select: { id: true, spaceId: true } }) : [];
    const bySpace = new Map(parents.map((p) => [p.id, p.spaceId]));
    const team = await db.space.findUnique({ where: { teamId: project.teamId }, select: { id: true } });
    return [...above.map((id) => bySpace.get(id)).filter((s): s is string => !!s), ...(team ? [team.id] : [])];
  }

  /** The labels a board of this space may use: the space's own and the inheritable ones above it. */
  async usable(spaceId: string, db: Db = this.prisma): Promise<Label[]> {
    const above = await this.ancestorSpaces(db, spaceId);
    return db.label.findMany({
      where: { deletedAt: null, OR: [{ spaceId }, ...(above.length ? [{ spaceId: { in: above }, inheritable: true }] : [])] },
    });
  }

  /** Throws unless every id is a live label usable in the space. */
  async assertUsable(db: Db, spaceId: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const ok = new Set((await this.usable(spaceId, db)).map((l) => l.id));
    if (ids.some((id) => !ok.has(id))) throw invalid('unknown_label');
  }

  async list(userId: string, spaceId: string): Promise<LabelDto[]> {
    await this.perms.requireBoardSpace(userId, spaceId);
    const rows = await this.usable(spaceId);
    return rows.map(toLabelDto).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
  }

  async create(userId: string, spaceId: string, input: CreateLabelInput): Promise<LabelDto> {
    await this.perms.requireBoardSpace(userId, spaceId, Permission.MANAGE_LABELS);
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.label.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw idTaken();
        return toLabelDto(existing);
      }
      if ((await tx.label.count({ where: { spaceId, deletedAt: null } })) >= BOARD_LIMITS.labelsPerSpace) throw new ConflictException('label_limit_reached');
      const row = await tx.label.create({
        data: {
          id: input.id,
          spaceId,
          name: input.name,
          color: input.color.toLowerCase(),
          description: input.description ?? '',
          inheritable: input.inheritable ?? true,
          seq,
        },
      });
      this.events.emit(tx, BOARD_EVENTS.labelCreated, { spaceId, boardId: null, id: row.id, payload: toLabelDto(row) });
      return toLabelDto(row);
    });
  }

  async update(userId: string, id: string, patch: UpdateLabelInput): Promise<LabelDto> {
    const label = await this.prisma.label.findUnique({ where: { id } });
    if (!label || label.deletedAt) throw notFound();
    await this.perms.requireBoardSpace(userId, label.spaceId, Permission.MANAGE_LABELS);
    return this.prisma.fresh(async (tx) => {
      const spaces = await this.lockSpaces(tx, label.spaceId, patch.inheritable === false && label.inheritable ? await this.usersOf(tx, id, label.spaceId) : []);
      const seq = spaces.get(label.spaceId)!;
      const current = await tx.label.findUnique({ where: { id } });
      if (!current || current.deletedAt) throw notFound();
      if (patch.inheritable === false && current.inheritable) await this.detachFromOtherSpaces(tx, id, label.spaceId, spaces);
      const row = await tx.label.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.color !== undefined && { color: patch.color.toLowerCase() }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.inheritable !== undefined && { inheritable: patch.inheritable }),
          seq,
        },
      });
      this.events.emit(tx, BOARD_EVENTS.labelUpdated, { spaceId: row.spaceId, boardId: null, id, payload: toLabelDto(row) });
      return toLabelDto(row);
    });
  }

  /** Deleting leaves a tombstone (so devices drop it) and takes the label off every task. */
  async remove(userId: string, id: string): Promise<void> {
    const label = await this.prisma.label.findUnique({ where: { id } });
    if (!label) throw notFound();
    await this.perms.requireBoardSpace(userId, label.spaceId, Permission.MANAGE_LABELS);
    if (label.deletedAt) return;
    await this.prisma.fresh(async (tx) => {
      const spaces = await this.lockSpaces(tx, label.spaceId, await this.usersOf(tx, id, label.spaceId));
      const current = await tx.label.findUnique({ where: { id } });
      if (!current || current.deletedAt) return;
      await this.detachFromOtherSpaces(tx, id, label.spaceId, spaces);
      const own = await tx.taskLabel.findMany({ where: { labelId: id, task: { spaceId: label.spaceId } }, select: { taskId: true } });
      if (own.length) await tx.task.updateMany({ where: { id: { in: own.map((o) => o.taskId) } }, data: { seq: spaces.get(label.spaceId)! } });
      await tx.taskLabel.deleteMany({ where: { labelId: id } });
      await tx.label.update({ where: { id }, data: { deletedAt: new Date(), seq: spaces.get(label.spaceId)! } });
      this.events.emit(tx, BOARD_EVENTS.labelDeleted, { spaceId: label.spaceId, boardId: null, id, payload: { id } });
    });
  }

  /** The spaces of the tasks (other than the label's own) that wear a label. */
  private async usersOf(tx: Tx, labelId: string, own: string): Promise<string[]> {
    const rows = await tx.task.findMany({ where: { spaceId: { not: own }, labels: { some: { labelId } } }, select: { spaceId: true }, distinct: ['spaceId'] });
    return rows.map((r) => r.spaceId);
  }

  /** Takes the next sequence number of every space involved, always in the same order so two writers cannot deadlock. */
  private async lockSpaces(tx: Tx, own: string, others: readonly string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const id of [...new Set([own, ...others])].sort()) out.set(id, await this.seq.next(tx, id));
    return out;
  }

  /** Removes the label from tasks in other spaces (a project below), bumping those tasks so their devices hear of it. */
  private async detachFromOtherSpaces(tx: Tx, labelId: string, own: string, seqs: ReadonlyMap<string, bigint>): Promise<void> {
    for (const [spaceId, seq] of seqs) {
      if (spaceId === own) continue;
      const tasks = await tx.taskLabel.findMany({ where: { labelId, task: { spaceId } }, select: { taskId: true } });
      if (!tasks.length) continue;
      await tx.task.updateMany({ where: { id: { in: tasks.map((t) => t.taskId) } }, data: { seq } });
      await tx.taskLabel.deleteMany({ where: { labelId, taskId: { in: tasks.map((t) => t.taskId) } } });
    }
  }
}
