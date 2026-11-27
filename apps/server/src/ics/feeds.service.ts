import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import type { CalendarFeedDto, CalendarFeedSecretDto, FeedIncludeDto } from '@os-planner/shared';
import {
  DEFAULT_FEED_INCLUDE,
  ICS_LIMITS,
  type CreateFeedInput,
  type UpdateFeedInput,
} from '@os-planner/shared/ics';
import { newId, randomToken, sha256Hex } from '../common/crypto.js';
import { ENV, feedBase, type Env } from '../config/env.js';
import type { CalendarFeed } from '../generated/prisma/client.js';
import { IcsExporter } from '../calendar/ics-export.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY = 86_400_000;
/** The secret is 32 random bytes, base64url: 43 characters. */
const FILE = /^([A-Za-z0-9_-]{43})\.ics$/;
/** Requests one feed answers in a minute before it says "too many" (a calendar app asks every few minutes, not every second). */
const FEED_RATE = 60;

const includeOf = (raw: unknown): FeedIncludeDto => ({
  ...DEFAULT_FEED_INCLUDE,
  ...((raw ?? {}) as Partial<FeedIncludeDto>),
});

const toDto = (f: CalendarFeed): CalendarFeedDto => ({
  id: f.id,
  name: f.name,
  include: includeOf(f.include),
  tokenHint: f.tokenHint,
  createdAt: f.createdAt.toISOString(),
  rotatedAt: f.rotatedAt?.toISOString() ?? null,
  lastFetchedAt: f.lastFetchedAt?.toISOString() ?? null,
  fetchCount: f.fetchCount,
});

export interface FeedAnswer {
  status: 200 | 304;
  body?: string;
  etag: string;
  lastModified: string;
}

/**
 * The private subscription address of a person's calendar. The address holds a secret nobody can guess; only its hash is kept, so
 * a leaked database does not leak calendars, and renewing the secret kills the old address. What the file holds is computed at
 * every request with the owner's permissions at that moment (a space they lost disappears on the next fetch).
 */
@Injectable()
export class FeedsService {
  /** Requests per feed in the current minute (kept in memory: a restart only forgets who asked). */
  private readonly hits = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly exporter: IcsExporter,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The address a calendar app is given: the API's own origin (calendar apps do not run the website). */
  url(token: string): string {
    return `${feedBase(this.env)}/api/feeds/${token}.ics`;
  }

  async list(userId: string): Promise<CalendarFeedDto[]> {
    return (
      await this.prisma.calendarFeed.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
    ).map(toDto);
  }

  private async mine(userId: string, id: string): Promise<CalendarFeed> {
    const row = await this.prisma.calendarFeed.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('not_found');
    return row;
  }

  async create(userId: string, input: CreateFeedInput): Promise<CalendarFeedSecretDto> {
    if ((await this.prisma.calendarFeed.count({ where: { userId } })) >= ICS_LIMITS.feedsPerUser)
      throw new ConflictException('too_many_feeds');
    const token = randomToken();
    const row = await this.prisma.calendarFeed.create({
      data: {
        id: newId(),
        userId,
        tokenHash: sha256Hex(token),
        tokenHint: token.slice(-6),
        name: input.name.trim(),
        include: { ...DEFAULT_FEED_INCLUDE, ...(input.include ?? {}) },
      },
    });
    return { ...toDto(row), url: this.url(token) };
  }

  async update(userId: string, id: string, patch: UpdateFeedInput): Promise<CalendarFeedDto> {
    const row = await this.mine(userId, id);
    const saved = await this.prisma.calendarFeed.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.include ? { include: { ...includeOf(row.include), ...patch.include } } : {}),
      },
    });
    return toDto(saved);
  }

  /** A new secret: the old address stops working at once. */
  async rotate(userId: string, id: string): Promise<CalendarFeedSecretDto> {
    await this.mine(userId, id);
    const token = randomToken();
    const row = await this.prisma.calendarFeed.update({
      where: { id },
      data: { tokenHash: sha256Hex(token), tokenHint: token.slice(-6), rotatedAt: new Date() },
    });
    return { ...toDto(row), url: this.url(token) };
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.mine(userId, id);
    await this.prisma.calendarFeed.delete({ where: { id } });
  }

  // ---------------------------------------------------------------- the public side

  private limited(hash: string, now: number): boolean {
    const h = this.hits.get(hash);
    if (!h || now - h.since > 60_000) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(hash, { count: 1, since: now });
      return false;
    }
    return ++h.count > FEED_RATE;
  }

  /**
   * The file for an address. An address that is wrong, renewed or deleted answers one and the same 404 (the same as a path that does
   * not exist), so nothing tells which it was.
   */
  async answer(
    file: string,
    conditional: { ifNoneMatch?: string | undefined; ifModifiedSince?: string | undefined },
  ): Promise<FeedAnswer> {
    const m = FILE.exec(file);
    if (!m) throw new NotFoundException();
    const hash = sha256Hex(m[1]!);
    if (this.limited(hash, Date.now())) throw new HttpException('too_many_requests', 429);
    const feed = await this.prisma.calendarFeed.findUnique({ where: { tokenHash: hash } });
    if (!feed) throw new NotFoundException();
    // The window and the stamp of entries without one move with the day, so the file only changes when the calendar does (or at midnight).
    const today = new Date(Math.floor(Date.now() / DAY) * DAY);
    const inc = includeOf(feed.include);
    const win = this.exporter.feedWindow(today);
    const { events } = await this.exporter.entries(feed.userId, {
      ...(inc.spaces ? { spaces: inc.spaces } : {}),
      meetings: inc.meetings,
      events: inc.events,
      tasks: inc.tasks,
      declined: inc.declined,
      from: win.from,
      to: win.to,
    });
    const body = this.exporter.render(feed.name, events, 60, today.toISOString());
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    const stamps = events.map((e) => e.updatedAt).filter((u): u is string => !!u);
    const lastModified = new Date(
      stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : today.toISOString(),
    ).toUTCString();
    await this.prisma.calendarFeed.update({
      where: { id: feed.id },
      data: { lastFetchedAt: new Date(), fetchCount: { increment: 1 } },
    });

    const inm = conditional.ifNoneMatch?.split(',').map((s) => s.trim().replace(/^W\//, ''));
    const unchanged =
      inm !== undefined
        ? inm.includes(etag) || inm.includes('*')
        : conditional.ifModifiedSince !== undefined &&
          Date.parse(conditional.ifModifiedSince) >= Date.parse(lastModified);
    return unchanged
      ? { status: 304, etag, lastModified }
      : { status: 200, body, etag, lastModified };
  }
}
