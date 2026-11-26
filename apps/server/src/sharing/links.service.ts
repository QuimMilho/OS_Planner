import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import argon2 from 'argon2';
import {
  LINK_PASSWORD_TRIES,
  Permission,
  type CreateLinkInput,
  type LinkViewDto,
  type PublicPageContentDto,
  type PublicSearchHitDto,
  type ShareAccess,
  type ShareLinkDto,
  type UpdateLinkInput,
} from '@os-planner/shared';
import { TokenService } from '../auth/token.service.js';
import { newId, randomToken, sha256Hex } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import type { Notebook, ShareLink, Space } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../roles/audit.service.js';
import { buildSnippet, parseSearchQuery, titleHits } from '../search/query.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SharesService } from './shares.service.js';

/** A notebook has at most this many links that still work. */
export const MAX_LINKS_PER_NOTEBOOK = 20;
/** Wrong passwords count for this long. */
export const PASSWORD_WINDOW_MS = 15 * 60_000;
const DAY = 24 * 60 * 60_000;

/** The answer for a link that is unknown, expired, revoked, or of a notebook that is gone: always this one, so nothing can be told apart. */
const invalid = () => new NotFoundException('invalid_link');

type LinkWithNotebook = ShareLink & { notebook: Notebook & { space: Space } };

/** What a request for a link has proven so far. */
export interface LinkContext {
  link: LinkWithNotebook;
}

const toDto = (l: ShareLink): ShareLinkDto => ({
  id: l.id,
  notebookId: l.notebookId,
  access: l.access as ShareAccess,
  hasPassword: l.passwordHash !== null,
  showAuthors: l.showAuthors,
  expiresAt: l.expiresAt?.toISOString() ?? null,
  revokedAt: l.revokedAt?.toISOString() ?? null,
  createdAt: l.createdAt.toISOString(),
  lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
});

/**
 * Share links: a token that opens one notebook. The owner side makes, changes and revokes them; the public side lets
 * anybody who holds the token read the notebook (never anything else), and a signed-in person with an edit link
 * turns it into an edit share bound to the link.
 *
 * Revocation, expiry and the notebook's own state are checked on every request. Everything that is wrong with a token
 * answers one and the same 404.
 */
@Injectable()
export class LinksService {
  /** Wrong passwords per link and address. Kept in memory: a restart or a second instance only makes guessing slightly easier, never access. */
  private readonly attempts = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly tokens: TokenService,
    private readonly shares: SharesService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------- the owner's side

  private url(token: string): string {
    return `${this.env.APP_URL.replace(/\/+$/, '')}/s/${token}`;
  }

  /** The team that owns a notebook's space, if any. */
  private async teamOf(
    space: Space,
  ): Promise<{ id: string; allowPublicLinks: boolean; deletedAt: Date | null } | null> {
    if (space.kind === 'personal') return null;
    let teamId = space.teamId;
    if (!teamId && space.projectId)
      teamId =
        (
          await this.prisma.project.findUnique({
            where: { id: space.projectId },
            select: { teamId: true },
          })
        )?.teamId ?? null;
    if (!teamId) return null;
    return this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, allowPublicLinks: true, deletedAt: true },
    });
  }

  async create(userId: string, notebookId: string, input: CreateLinkInput): Promise<ShareLinkDto> {
    const access = await this.perms.requireNotebook(userId, notebookId, Permission.SHARE_NOTEBOOKS);
    if (access.via !== 'space') throw new ForbiddenException('forbidden');
    const team = await this.teamOf(
      await this.prisma.space.findUniqueOrThrow({ where: { id: access.notebook.spaceId } }),
    );
    if (team) {
      // A team's notebooks can only be read by the public, and only when the team allows it.
      if (!team.allowPublicLinks) throw new ForbiddenException('public_links_disabled');
      if (input.access !== 'read') throw new UnprocessableEntityException('team_links_read_only');
    }
    const active = await this.prisma.shareLink.count({
      where: {
        notebookId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (active >= MAX_LINKS_PER_NOTEBOOK) throw new ConflictException('link_limit_reached');

    const token = randomToken();
    const passwordHash = input.password
      ? await argon2.hash(input.password, { type: argon2.argon2id })
      : null;
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shareLink.create({
        data: {
          id: newId(),
          notebookId,
          tokenHash: sha256Hex(token),
          access: input.access,
          passwordHash,
          showAuthors: input.showAuthors ?? false,
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY) : null,
          createdBy: userId,
        },
      });
      if (team)
        await this.audit.record(tx, {
          teamId: team.id,
          actorId: userId,
          action: 'notebook.link.create',
          targetKind: 'notebook',
          targetId: notebookId,
          after: {
            access: input.access,
            expires: created.expiresAt,
            password: passwordHash !== null,
          },
        });
      return created;
    });
    return { ...toDto(row), token, url: this.url(token) };
  }

  async list(userId: string, notebookId: string): Promise<ShareLinkDto[]> {
    await this.perms.requireNotebook(userId, notebookId, Permission.SHARE_NOTEBOOKS);
    const rows = await this.prisma.shareLink.findMany({
      where: { notebookId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  /** The link, if the person may manage the notebook it opens (404 for a link of a notebook they cannot see). */
  private async managed(
    userId: string,
    linkId: string,
  ): Promise<{ link: ShareLink; teamId: string | null }> {
    const link = await this.prisma.shareLink.findUnique({
      where: { id: linkId },
      include: { notebook: { include: { space: true } } },
    });
    if (!link) throw new NotFoundException();
    await this.perms.requireNotebook(userId, link.notebookId, Permission.SHARE_NOTEBOOKS);
    return { link, teamId: (await this.teamOf(link.notebook.space))?.id ?? null };
  }

  async update(userId: string, linkId: string, patch: UpdateLinkInput): Promise<ShareLinkDto> {
    const { link } = await this.managed(userId, linkId);
    if (link.revokedAt) throw new NotFoundException();
    const passwordHash =
      patch.password === undefined
        ? undefined
        : patch.password === null
          ? null
          : await argon2.hash(patch.password, { type: argon2.argon2id });
    const row = await this.prisma.shareLink.update({
      where: { id: linkId },
      data: {
        ...(passwordHash !== undefined && { passwordHash }),
        ...(patch.showAuthors !== undefined && { showAuthors: patch.showAuthors }),
        ...(patch.expiresInDays !== undefined && {
          expiresAt:
            patch.expiresInDays === null ? null : new Date(Date.now() + patch.expiresInDays * DAY),
        }),
      },
    });
    return toDto(row);
  }

  /** Ends the link and every edit share that came from it, at once. */
  async revoke(userId: string, linkId: string): Promise<void> {
    const { link, teamId } = await this.managed(userId, linkId);
    if (link.revokedAt) return;
    const affected = await this.prisma.$transaction(async (tx) => {
      await tx.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
      const bound = await tx.notebookShare.findMany({
        where: { linkId },
        select: { userId: true },
      });
      await tx.notebookShare.deleteMany({ where: { linkId } });
      if (teamId)
        await this.audit.record(tx, {
          teamId,
          actorId: userId,
          action: 'notebook.link.revoke',
          targetKind: 'notebook',
          targetId: link.notebookId,
        });
      return bound.map((b) => b.userId);
    });
    await this.shares.announce(affected);
  }

  // ---------------------------------------------------------------- the public side

  private tooMany(): HttpException {
    return new HttpException('too_many_attempts', HttpStatus.TOO_MANY_REQUESTS);
  }

  private blocked(key: string): boolean {
    const a = this.attempts.get(key);
    if (!a) return false;
    if (Date.now() - a.since > PASSWORD_WINDOW_MS) {
      this.attempts.delete(key);
      return false;
    }
    return a.count >= LINK_PASSWORD_TRIES;
  }

  private failed(key: string): void {
    const a = this.attempts.get(key);
    if (!a || Date.now() - a.since > PASSWORD_WINDOW_MS)
      this.attempts.set(key, { count: 1, since: Date.now() });
    else a.count++;
    if (this.attempts.size > 10_000)
      for (const [k, v] of this.attempts)
        if (Date.now() - v.since > PASSWORD_WINDOW_MS) this.attempts.delete(k);
  }

  /** The link behind a token if it works right now, else the one invalid answer. */
  private async load(token: string): Promise<LinkWithNotebook> {
    const link = await this.prisma.shareLink.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { notebook: { include: { space: true } } },
    });
    if (
      !link ||
      link.revokedAt ||
      (link.expiresAt && link.expiresAt.getTime() <= Date.now()) ||
      link.notebook.deletedAt
    )
      throw invalid();
    const team = await this.teamOf(link.notebook.space);
    if (link.notebook.space.kind !== 'personal') {
      // A team's notebook is open to the public only while the team allows it, and only for reading.
      if (!team || team.deletedAt || !team.allowPublicLinks || link.access !== 'read')
        throw invalid();
    }
    return link;
  }

  /**
   * Opens a link for reading. A link with a password needs either the password (checked here, throttled per link and
   * address) or the session an earlier answer handed out.
   */
  async open(token: string, ip: string, password?: string, session?: string): Promise<LinkContext> {
    const link = await this.load(token);
    if (link.passwordHash) {
      const proven = session ? (await this.tokens.verifyLinkSession(session)) === link.id : false;
      if (!proven) {
        const key = `${link.id}|${ip}`;
        if (this.blocked(key)) throw this.tooMany();
        if (password === undefined) throw new UnauthorizedException('password_required');
        const ok = await argon2.verify(link.passwordHash, password).catch(() => false);
        if (!ok) {
          this.failed(key);
          throw new ForbiddenException('wrong_password');
        }
        this.attempts.delete(key);
      }
    }
    return { link };
  }

  async resolve(token: string, ip: string, password?: string): Promise<LinkViewDto> {
    const { link } = await this.open(token, ip, password);
    // At most once a minute: a busy link must not turn every view into a write.
    if (!link.lastUsedAt || Date.now() - link.lastUsedAt.getTime() > 60_000)
      await this.prisma.shareLink
        .update({ where: { id: link.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);

    const [categories, pages] = await Promise.all([
      this.prisma.category.findMany({
        where: { notebookId: link.notebookId, deletedAt: null },
        select: { id: true, parentId: true, name: true, position: true },
      }),
      this.prisma.page.findMany({
        where: { notebookId: link.notebookId, deletedAt: null },
        select: { id: true, categoryId: true, title: true, position: true, updatedAt: true },
      }),
    ]);
    const owner =
      link.showAuthors && link.notebook.space.kind === 'personal' && link.notebook.space.userId
        ? ((
            await this.prisma.user.findUnique({
              where: { id: link.notebook.space.userId },
              select: { displayName: true },
            })
          )?.displayName ?? null)
        : null;
    return {
      notebook: {
        id: link.notebook.id,
        name: link.notebook.name,
        icon: link.notebook.icon,
        color: link.notebook.color,
      },
      access: link.access as ShareAccess,
      ownerName: owner,
      categories,
      pages: pages.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() })),
      session: await this.tokens.signLinkSession(link.id),
    };
  }

  /** One page of the linked notebook: any other id (another notebook's page, a trashed page) is the invalid-link answer. */
  async page(
    token: string,
    ip: string,
    pageId: string,
    session?: string,
  ): Promise<PublicPageContentDto> {
    const { link } = await this.open(token, ip, undefined, session);
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, notebookId: link.notebookId, deletedAt: null },
      select: {
        id: true,
        categoryId: true,
        title: true,
        position: true,
        updatedAt: true,
        content: true,
      },
    });
    if (!page) throw invalid();
    return {
      ...page,
      updatedAt: page.updatedAt.toISOString(),
      content: page.content as PublicPageContentDto['content'],
    };
  }

  /** The stored file, if a live page of the linked notebook uses it. */
  async media(
    token: string,
    ip: string,
    mediaId: string,
    session?: string,
  ): Promise<{ mime: string; path: { userId: string; id: string } }> {
    const { link } = await this.open(token, ip, undefined, session);
    const used = await this.prisma.pageMedia.findFirst({
      where: { mediaId, page: { notebookId: link.notebookId, deletedAt: null } },
      select: { media: { select: { id: true, userId: true, mime: true } } },
    });
    if (!used) throw invalid();
    return { mime: used.media.mime, path: { userId: used.media.userId, id: used.media.id } };
  }

  /** Full-text search inside the linked notebook only. */
  async search(
    token: string,
    ip: string,
    q: string,
    session?: string,
  ): Promise<PublicSearchHitDto[]> {
    const { link } = await this.open(token, ip, undefined, session);
    const query = parseSearchQuery(q);
    if (!query.boolean) return [];
    const rows = await this.prisma.$queryRaw<
      { id: string; title: string; categoryName: string; contentText: string; score: number }[]
    >(Prisma.sql`
      SELECT p.id, p.title, c.name AS categoryName, p.contentText,
             MATCH(p.title, p.contentText) AGAINST (${query.boolean} IN BOOLEAN MODE) AS score
      FROM Page p
      JOIN Category c ON c.id = p.categoryId
      WHERE p.notebookId = ${link.notebookId}
        AND p.deletedAt IS NULL AND c.deletedAt IS NULL
        AND MATCH(p.title, p.contentText) AGAINST (${query.boolean} IN BOOLEAN MODE)
      ORDER BY score DESC
      LIMIT 60
    `);
    return rows
      .map((r) => ({ r, rank: Number(r.score) + titleHits(r.title, query) * 2 }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 20)
      .map(({ r }) => ({
        pageId: r.id,
        title: r.title,
        categoryName: r.categoryName,
        snippet: buildSnippet(r.contentText, query),
      }));
  }

  // ---------------------------------------------------------------- an edit link used by a signed-in person

  /**
   * A signed-in person uses an edit link: the notebook becomes theirs to edit (an edit share bound to the link, so
   * revoking the link ends it, even in the middle of a session). Anonymous visitors never get here (401 before).
   */
  async join(
    userId: string,
    token: string,
    ip: string,
    password?: string,
  ): Promise<{ notebookId: string; access: ShareAccess }> {
    const { link } = await this.open(token, ip, password);
    if (link.access !== 'edit') throw new UnprocessableEntityException('link_is_read_only');
    if (link.notebook.space.userId === userId)
      return { notebookId: link.notebookId, access: 'edit' }; // the owner
    await this.prisma.$transaction((tx) =>
      this.shares.bindToLink(tx, link.notebookId, userId, link.createdBy, link.id),
    );
    await this.shares.announce([userId]);
    return { notebookId: link.notebookId, access: 'edit' };
  }
}
