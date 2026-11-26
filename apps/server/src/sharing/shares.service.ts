import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Permission,
  type Locale,
  type NotebookSharesDto,
  type PendingShareDto,
  type PutShareInput,
  type PutShareResult,
  type ShareAccess,
  type ShareDto,
  type SharedNotebookDto,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import { EventBus } from '../events/event-bus.js';
import type { NotebookShare, Prisma } from '../generated/prisma/client.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';

/** One notebook is shared with at most this many people (and as many addresses still waiting for an account). */
export const MAX_SHARES_PER_NOTEBOOK = 100;

type ShareWithUser = NotebookShare & { user: { displayName: string; email: string } };

const toDto = (s: ShareWithUser): ShareDto => ({
  id: s.id,
  userId: s.userId,
  displayName: s.user.displayName,
  email: s.user.email,
  access: s.access as ShareAccess,
  viaLink: s.linkId !== null,
  createdAt: s.createdAt.toISOString(),
});

/**
 * Notebooks shared with people. Only notebooks of a personal space are shared this way (team and project notebooks are
 * governed by roles and overwrites); the owner is who may share, and nobody who was given access may pass it on.
 */
@Injectable()
export class SharesService {
  private readonly log = new Logger(SharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly bus: EventBus,
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------- the recipient's side

  /** Every live notebook shared with the person, with who owns it and what they may do. */
  async sharedWithMe(userId: string): Promise<SharedNotebookDto[]> {
    const rows = await this.perms.sharesOf(userId);
    if (!rows.length) return [];
    const owners = await this.prisma.space.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.notebook.spaceId))] } },
      select: { id: true, user: { select: { displayName: true } } },
    });
    const ownerName = new Map(owners.map((o) => [o.id, o.user?.displayName ?? '']));
    return rows
      .map((r) => ({
        notebookId: r.notebookId,
        spaceId: r.notebook.spaceId,
        name: r.notebook.name,
        icon: r.notebook.icon,
        color: r.notebook.color,
        access: r.access as ShareAccess,
        ownerName: ownerName.get(r.notebook.spaceId) ?? '',
        viaLink: r.linkId !== null,
        sharedAt: r.createdAt.toISOString(),
      }))
      .sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
  }

  /** The recipient gives a notebook back. */
  async leave(userId: string, notebookId: string): Promise<void> {
    const share = await this.prisma.notebookShare.findUnique({
      where: { notebookId_userId: { notebookId, userId } },
    });
    if (!share) return;
    await this.prisma.notebookShare.delete({ where: { id: share.id } });
    await this.announce([userId]);
  }

  // ---------------------------------------------------------------- the owner's side

  /** The notebook, if the person may share it (404 when they cannot see it, 403 when they cannot share it). */
  private async shareable(userId: string, notebookId: string) {
    const access = await this.perms.requireNotebook(userId, notebookId, Permission.SHARE_NOTEBOOKS);
    return access;
  }

  /** Direct shares only exist for notebooks in a personal space. */
  private async personal(userId: string, notebookId: string) {
    const access = await this.shareable(userId, notebookId);
    if (access.via !== 'space' || access.chat)
      throw new UnprocessableEntityException('shares_personal_only');
    return access;
  }

  async list(userId: string, notebookId: string): Promise<NotebookSharesDto> {
    await this.personal(userId, notebookId);
    const [shares, pending] = await Promise.all([
      this.prisma.notebookShare.findMany({
        where: { notebookId },
        include: { user: { select: { displayName: true, email: true } } },
      }),
      this.prisma.pendingShare.findMany({ where: { notebookId } }),
    ]);
    return {
      shares: shares.map(toDto).sort((a, b) => a.displayName.localeCompare(b.displayName)),
      pending: pending
        .map((p): PendingShareDto => ({
          id: p.id,
          email: p.email,
          access: p.access as ShareAccess,
          createdAt: p.createdAt.toISOString(),
        }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    };
  }

  /**
   * Shares with a person (by id: only people the owner shares a team with) or an address. For an address the answer is the
   * same whether or not an account exists, and a person whose address is not verified yet waits as a pending share: nobody
   * gets a notebook by registering an address they do not control.
   */
  async put(userId: string, notebookId: string, input: PutShareInput): Promise<PutShareResult> {
    const { notebook } = await this.personal(userId, notebookId);
    const owner = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true, email: true, locale: true },
    });

    if (input.userId !== undefined) {
      if (input.userId === userId) throw new UnprocessableEntityException('cannot_share_with_self');
      const target = await this.prisma.user.findFirst({
        where: {
          id: input.userId,
          teamMemberships: { some: { team: { deletedAt: null, members: { some: { userId } } } } },
        },
        select: { id: true },
      });
      if (!target) throw new NotFoundException('user_not_found');
      const share = await this.grant(userId, notebookId, input.userId, input.access, null);
      void this.notify(input.userId, owner.displayName, notebook.name, input.access);
      return { ok: true, share };
    }

    const email = input.email!.toLowerCase();
    if (email === owner.email.toLowerCase())
      throw new UnprocessableEntityException('cannot_share_with_self');
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, emailVerifiedAt: true, locale: true },
    });
    if (user?.emailVerifiedAt) {
      await this.grant(userId, notebookId, user.id, input.access, null);
      void this.mail.sendShare(
        email,
        (user.locale as Locale) ?? 'en',
        owner.displayName,
        notebook.name,
        input.access,
        true,
      );
    } else {
      await this.prisma.$transaction(async (tx) => {
        const taken = await tx.pendingShare.count({ where: { notebookId } });
        const existing = await tx.pendingShare.findUnique({
          where: { notebookId_email: { notebookId, email } },
        });
        if (!existing && taken >= MAX_SHARES_PER_NOTEBOOK)
          throw new ConflictException('share_limit_reached');
        if (existing)
          await tx.pendingShare.update({
            where: { id: existing.id },
            data: { access: input.access },
          });
        else
          await tx.pendingShare.create({
            data: { id: newId(), notebookId, email, access: input.access, createdBy: userId },
          });
      });
      void this.mail.sendShare(
        email,
        (owner.locale as Locale) ?? 'en',
        owner.displayName,
        notebook.name,
        input.access,
        false,
      );
    }
    return { ok: true };
  }

  /** Creates or changes a share (also used when somebody verifies an address that was waiting). */
  private async grant(
    createdBy: string,
    notebookId: string,
    recipientId: string,
    access: ShareAccess,
    linkId: string | null,
  ): Promise<ShareDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notebookShare.findUnique({
        where: { notebookId_userId: { notebookId, userId: recipientId } },
      });
      if (
        !existing &&
        (await tx.notebookShare.count({ where: { notebookId } })) >= MAX_SHARES_PER_NOTEBOOK
      )
        throw new ConflictException('share_limit_reached');
      const data = { access, linkId };
      return existing
        ? tx.notebookShare.update({
            where: { id: existing.id },
            data,
            include: { user: { select: { displayName: true, email: true } } },
          })
        : tx.notebookShare.create({
            data: { id: newId(), notebookId, userId: recipientId, createdBy, ...data },
            include: { user: { select: { displayName: true, email: true } } },
          });
    });
    await this.announce([recipientId]);
    return toDto(row);
  }

  async remove(userId: string, notebookId: string, shareId: string): Promise<void> {
    await this.personal(userId, notebookId);
    const share = await this.prisma.notebookShare.findFirst({ where: { id: shareId, notebookId } });
    if (!share) return;
    await this.prisma.notebookShare.delete({ where: { id: share.id } });
    await this.announce([share.userId]);
  }

  async removePending(userId: string, notebookId: string, pendingId: string): Promise<void> {
    await this.personal(userId, notebookId);
    await this.prisma.pendingShare.deleteMany({ where: { id: pendingId, notebookId } });
  }

  // ---------------------------------------------------------------- shares that were waiting for an account

  /**
   * Called whenever somebody signs in or verifies their address: shares made to that address start now. A notebook that is
   * gone, or one whose owner no longer may share it, is dropped without a word.
   */
  async applyPending(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) return 0;
    const waiting = await this.prisma.pendingShare.findMany({
      where: { email: user.email.toLowerCase() },
      include: { notebook: { include: { space: true } } },
    });
    let applied = 0;
    for (const p of waiting) {
      try {
        const live =
          !p.notebook.deletedAt &&
          p.notebook.space.kind === 'personal' &&
          p.notebook.space.userId === p.createdBy;
        if (live && p.notebook.space.userId !== userId) {
          await this.grant(p.createdBy, p.notebookId, userId, p.access as ShareAccess, null);
          applied++;
        }
      } catch (e) {
        this.log.log(`pending share ${p.id} not applied: ${e instanceof Error ? e.message : e}`);
      }
      await this.prisma.pendingShare.deleteMany({ where: { id: p.id } });
    }
    return applied;
  }

  // ---------------------------------------------------------------- shared with other parts

  /** Ends every share and link of a notebook (it moved to another space, or was purged) inside the caller's transaction. */
  async endAll(tx: Tx, notebookId: string): Promise<string[]> {
    const shares = await tx.notebookShare.findMany({
      where: { notebookId },
      select: { userId: true },
    });
    await tx.notebookShare.deleteMany({ where: { notebookId } });
    await tx.pendingShare.deleteMany({ where: { notebookId } });
    await tx.shareLink.updateMany({
      where: { notebookId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return shares.map((s) => s.userId);
  }

  /** Tells these people their shared notebooks changed (their client pulls and their rooms are re-checked). */
  async announce(userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    await this.bus.publish('permissions.changed', { userIds });
    await this.bus.publish('room.event', {
      rooms: userIds.map((id) => `user:${id}`),
      name: 'shares.changed',
      payload: {},
    });
  }

  /** Binds an edit share to the link it came from; the link's revocation ends it. Returns the share. */
  async bindToLink(
    tx: Prisma.TransactionClient,
    notebookId: string,
    recipientId: string,
    ownerId: string,
    linkId: string,
  ): Promise<void> {
    const existing = await tx.notebookShare.findUnique({
      where: { notebookId_userId: { notebookId, userId: recipientId } },
    });
    // Somebody who already has direct edit access keeps it as it is (it must not vanish with a link).
    if (existing?.access === 'edit' && existing.linkId === null) return;
    if (
      !existing &&
      (await tx.notebookShare.count({ where: { notebookId } })) >= MAX_SHARES_PER_NOTEBOOK
    )
      throw new ConflictException('share_limit_reached');
    if (existing)
      await tx.notebookShare.update({
        where: { id: existing.id },
        data: { access: 'edit', linkId },
      });
    else
      await tx.notebookShare.create({
        data: {
          id: newId(),
          notebookId,
          userId: recipientId,
          access: 'edit',
          linkId,
          createdBy: ownerId,
        },
      });
  }

  private async notify(
    recipientId: string,
    sharer: string,
    notebook: string,
    access: ShareAccess,
  ): Promise<void> {
    const to = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { email: true, locale: true, emailVerifiedAt: true },
    });
    if (to?.emailVerifiedAt)
      await this.mail.sendShare(
        to.email,
        (to.locale as Locale) ?? 'en',
        sharer,
        notebook,
        access,
        true,
      );
  }
}
