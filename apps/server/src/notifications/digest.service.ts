import { createSecretKey } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { type Locale, type MailActionResultDto, type ScopeKind } from '@os-planner/shared';
import {
  chatMarkdownToText,
  inQuietHours,
  NOTIFY_LIMITS,
  quietHoursSchema,
} from '@os-planner/shared/chat';
import { ENV, type Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { RealtimeServer, userRoom } from '../realtime/realtime.server.js';
import { copyFor } from './copy.js';
import { NotificationSettingsService, type ScopeRef } from './settings.service.js';

const MINUTE = 60_000;
/** An unsubscribe or mute link in an email works this long. */
export const MAIL_LINK_DAYS = 60;
const KEEP_IDS = 20;
type MailScope = 'channel' | 'dm';

/**
 * The email option of a chat (`off`, `mentions` or `all`, and "only when I am away"). It is separate from notifications:
 * a person can have no push and a mail about a channel, or the reverse.
 *
 * Nothing is sent from the request that wrote the message. It records, per person and chat, that something is waiting. A
 * sweep then sends at most one mail per chat every 15 minutes (a count and the last few messages), only when the person has no
 * page open that they have used lately (if they asked for that), never during quiet hours, and leaves out what they have
 * already read.
 */
@Injectable()
export class DigestService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(DigestService.name);
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private readonly key;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: NotificationSettingsService,
    private readonly mail: MailService,
    private readonly rt: RealtimeServer,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.key = createSecretKey(Buffer.from(env.JWT_MEDIA_SECRET, 'utf8'));
  }

  onApplicationBootstrap(): void {
    if (!this.env.NOTIFY_SWEEP_SECONDS) return;
    this.timer = setInterval(() => void this.flush(), this.env.NOTIFY_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- waiting

  /** Something for this person in this chat is waiting to be mailed (inside the transaction that wrote the message). */
  async queue(
    tx: Tx,
    userId: string,
    scopeKind: MailScope,
    scopeId: string,
    messageId: string,
  ): Promise<void> {
    const where = { userId_scopeKind_scopeId: { userId, scopeKind, scopeId } };
    const state = await tx.emailDigestState.findUnique({ where });
    const ids = [
      ...(Array.isArray(state?.pendingIds) ? (state!.pendingIds as string[]) : []),
      messageId,
    ].slice(-KEEP_IDS);
    if (!state)
      await tx.emailDigestState.create({
        data: {
          userId,
          scopeKind,
          scopeId,
          pendingCount: 1,
          pendingIds: ids,
          pendingSince: new Date(),
        },
      });
    else
      await tx.emailDigestState.update({
        where,
        data: {
          pendingCount: { increment: 1 },
          pendingIds: ids,
          pendingSince: state.pendingSince ?? new Date(),
        },
      });
  }

  /** A message was deleted or edited away: it is not worth a mail any more. The sweep checks again before sending. */
  async forget(tx: Tx, messageId: string): Promise<void> {
    const rows = await tx.emailDigestState.findMany({ where: { pendingCount: { gt: 0 } } });
    for (const r of rows) {
      const ids = Array.isArray(r.pendingIds) ? (r.pendingIds as string[]) : [];
      if (ids.includes(messageId))
        await tx.emailDigestState.update({
          where: {
            userId_scopeKind_scopeId: {
              userId: r.userId,
              scopeKind: r.scopeKind,
              scopeId: r.scopeId,
            },
          },
          data: {
            pendingIds: ids.filter((i) => i !== messageId),
            pendingCount: Math.max(0, r.pendingCount - 1),
          },
        });
    }
  }

  // ---------------------------------------------------------------- sending

  /** Whether a page of the person was used within the away limit. */
  async isActive(userId: string, now: number): Promise<boolean> {
    if (!this.rt.started) return false;
    const limit = this.env.NOTIFY_AWAY_SECONDS * 1000;
    return (await this.rt.socketsIn(userRoom(userId))).some(
      (s) => now - s.data.lastActivity < limit,
    );
  }

  /** Sends what is due. Returns how many mails went out. Safe to call from several instances at once. */
  async flush(now = Date.now()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const interval = this.env.NOTIFY_EMAIL_INTERVAL_MINUTES * MINUTE;
      const due = await this.prisma.emailDigestState.findMany({
        where: {
          pendingCount: { gt: 0 },
          OR: [{ lastEmailedAt: null }, { lastEmailedAt: { lte: new Date(now - interval) } }],
        },
        take: 200,
      });
      let sent = 0;
      for (const state of due) {
        try {
          if (await this.deliver(state, now)) sent++;
        } catch (e) {
          this.log.error(`email digest failed: ${e instanceof Error ? e.stack : e}`);
        }
      }
      return sent;
    } finally {
      this.sweeping = false;
    }
  }

  private async deliver(
    state: {
      userId: string;
      scopeKind: string;
      scopeId: string;
      pendingCount: number;
      pendingIds: unknown;
    },
    now: number,
  ): Promise<boolean> {
    const { userId } = state;
    const scopeKind = state.scopeKind as MailScope;
    const where = { userId_scopeKind_scopeId: { userId, scopeKind, scopeId: state.scopeId } };
    const clear = (): Promise<unknown> =>
      this.prisma.emailDigestState.updateMany({
        where: { userId, scopeKind, scopeId: state.scopeId },
        data: { pendingCount: 0, pendingIds: [], pendingSince: null },
      });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        displayName: true,
        email: true,
        locale: true,
        quietHours: true,
        emailVerifiedAt: true,
      },
    });
    if (!user?.emailVerifiedAt) return (void (await clear()), false);

    // What the person wants now (they may have switched it off since the message came).
    const eff = await this.settings.effectiveRules(
      userId,
      await this.settings.chainOf(scopeKind, state.scopeId),
      now,
    );
    if (eff.email === 'off') return (void (await clear()), false);
    if (eff.emailOnlyWhenAway && (await this.isActive(userId, now))) return false; // try again later
    const quiet = quietHoursSchema.safeParse(user.quietHours);
    if (quiet.success && inQuietHours(quiet.data, new Date(now))) return false;

    // Only what is still there and not read.
    const ids = Array.isArray(state.pendingIds) ? (state.pendingIds as string[]) : [];
    const messages = await this.prisma.message.findMany({
      where: { id: { in: ids }, deletedAt: null, NOT: { authorId: userId } },
      include: { channel: { include: { reads: { where: { userId } } } } },
      orderBy: { id: 'asc' },
    });
    const unread = messages.filter((m) => {
      const read = m.channel.reads[0]?.lastReadMessageId;
      return !read || m.id > read;
    });
    if (!unread.length) return (void (await clear()), false);

    // Claim it: of several instances only the one whose update matches sends.
    const claimed = await this.prisma.emailDigestState.updateMany({
      where: { userId, scopeKind, scopeId: state.scopeId, pendingCount: state.pendingCount },
      data: { pendingCount: 0, pendingIds: [], pendingSince: null, lastEmailedAt: new Date(now) },
    });
    if (!claimed.count) return false;

    const locale = (user.locale === 'pt' ? 'pt' : 'en') as Locale;
    const channel = unread[0]!.channel;
    const redact = channel.redactPreviews || channel.nsfw;
    const names = new Map(
      (
        await this.prisma.user.findMany({
          where: {
            id: {
              in: [
                ...new Set(unread.map((m) => m.authorId).filter((v): v is string => v !== null)),
              ],
            },
          },
          select: { id: true, displayName: true },
        })
      ).map((u) => [u.id, u.displayName]),
    );
    const c = copyFor(locale);
    let where_: string;
    let team: string | null = null;
    let path: string;
    if (scopeKind === 'dm') {
      const dm = await this.prisma.directConversation.findUnique({ where: { id: state.scopeId } });
      const peer = dm ? (dm.userA === userId ? dm.userB : dm.userA) : null;
      where_ =
        (peer
          ? (names.get(peer) ??
            (
              await this.prisma.user.findUnique({
                where: { id: peer },
                select: { displayName: true },
              })
            )?.displayName)
          : null) ?? c.deletedUser;
      path = `/app/dm/${state.scopeId}`;
    } else {
      where_ = `#${channel.name}`;
      const space = channel.spaceId
        ? await this.prisma.space.findUnique({
            where: { id: channel.spaceId },
            select: { teamId: true, projectId: true },
          })
        : null;
      const teamId =
        space?.teamId ??
        (space?.projectId
          ? (
              await this.prisma.project.findUnique({
                where: { id: space.projectId },
                select: { teamId: true },
              })
            )?.teamId
          : null);
      team = teamId
        ? ((await this.prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }))
            ?.name ?? null)
        : null;
      path = `/app/c/${channel.id}`;
    }
    const lines = unread.slice(-NOTIFY_LIMITS.mailMessages).map((m) => ({
      author: (m.authorId && names.get(m.authorId)) || c.deletedUser,
      text: redact ? c.mailRedacted : chatMarkdownToText(m.content).slice(0, 200) || '…',
    }));

    const base = this.env.APP_URL.replace(/\/+$/, '');
    const ref: ScopeRef = { scopeKind: scopeKind as ScopeKind, scopeId: state.scopeId };
    const unsubscribe = `${base}/mail/action?token=${encodeURIComponent(await this.signAction(userId, ref, 'unsubscribe'))}`;
    const mute = `${base}/mail/action?token=${encodeURIComponent(await this.signAction(userId, ref, 'mute'))}`;
    await this.mail.sendNotificationDigest(user.email, user.displayName, locale, {
      where: where_,
      team,
      count: unread.length,
      lines,
      more: Math.max(0, unread.length - lines.length),
      openUrl: `${base}${path}`,
      unsubscribeUrl: unsubscribe,
      muteUrl: mute,
    });
    void where;
    return true;
  }

  // ---------------------------------------------------------------- the links in a mail

  signAction(userId: string, scope: ScopeRef, act: 'unsubscribe' | 'mute'): Promise<string> {
    return new SignJWT({ act, sk: scope.scopeKind, si: scope.scopeId ?? '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience('mail-action')
      .setIssuedAt()
      .setExpirationTime(`${MAIL_LINK_DAYS}d`)
      .sign(this.key);
  }

  /** Applies the link. Opening it twice does the same thing twice; a bad or old link is `invalid_link`. */
  async applyAction(token: string): Promise<MailActionResultDto> {
    let claims: { sub?: string; act?: unknown; sk?: unknown; si?: unknown };
    try {
      claims = (
        await jwtVerify(token, this.key, { audience: 'mail-action', algorithms: ['HS256'] })
      ).payload;
    } catch {
      throw new BadRequestException('invalid_link');
    }
    const act =
      claims.act === 'mute' ? 'mute' : claims.act === 'unsubscribe' ? 'unsubscribe' : null;
    const kind = claims.sk === 'channel' || claims.sk === 'dm' ? claims.sk : null;
    if (!claims.sub || !act || !kind || typeof claims.si !== 'string')
      throw new BadRequestException('invalid_link');
    if (!(await this.prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true } })))
      throw new BadRequestException('invalid_link');
    const scope: ScopeRef = { scopeKind: kind, scopeId: claims.si };
    await this.settings.setFromMail(claims.sub, scope, act);
    await this.prisma.emailDigestState.updateMany({
      where: { userId: claims.sub, scopeKind: kind, scopeId: claims.si },
      data: { pendingCount: 0, pendingIds: [], pendingSince: null },
    });
    let scopeName: string | null = null;
    if (kind === 'channel')
      scopeName =
        (await this.prisma.channel.findUnique({ where: { id: claims.si }, select: { name: true } }))
          ?.name ?? null;
    return { action: act, scopeKind: kind, scopeName };
  }
}
