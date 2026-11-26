import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import webpush from 'web-push';
import {
  type PushDeviceDto,
  type PushPayload,
  type PushSubscribeInput,
  type VapidKeyDto,
} from '@os-planner/shared';
import { inQuietHours, NOTIFY_LIMITS, quietHoursSchema } from '@os-planner/shared/chat';
import { newId } from '../common/crypto.js';
import { ENV, pushEnabled, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeServer, userRoom } from '../realtime/realtime.server.js';

/** The push services of the big browsers. A subscription for any other address is refused (the server would be fetching it). */
const KNOWN_HOSTS: readonly (string | RegExp)[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  /^updates-autopush[\w.-]*\.(?:stage\.)?mozaws\.net$/,
  'web.push.apple.com',
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

/** A page showing the channel this recently counts as looking at it: no push is needed. */
const FOCUS_FRESH_MS = 60_000;
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Web Push: stores the devices that subscribed and sends them what the notification pipeline decided. Messages are
 * encrypted for each device by the `web-push` library; the request itself is made here so the address can be checked first and
 * redirects are never followed. A device the push service says is gone (404, 410) is forgotten.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  /** `${userId}:${channelId}` → when the last push for it went out (this instance only). */
  private readonly lastPush = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rt: RealtimeServer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get enabled(): boolean {
    return pushEnabled(this.env);
  }

  vapidKey(): VapidKeyDto {
    if (!this.enabled) throw new NotFoundException(); // push is off: the website hides the option
    return { publicKey: this.env.VAPID_PUBLIC_KEY! };
  }

  // ---------------------------------------------------------------- devices

  /** https, and one of the browsers' push services (or an origin the administrator listed). */
  endpointAllowed(endpoint: string): boolean {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    if (this.env.PUSH_EXTRA_ENDPOINTS.includes(url.origin)) return true;
    if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
    return KNOWN_HOSTS.some((h) =>
      typeof h === 'string' ? url.hostname === h : h.test(url.hostname),
    );
  }

  async subscribe(userId: string, input: PushSubscribeInput): Promise<PushDeviceDto> {
    if (!this.enabled) throw new NotFoundException();
    if (!this.endpointAllowed(input.endpoint)) throw new BadRequestException('invalid_endpoint');
    const endpointHash = createHash('sha256').update(input.endpoint).digest('hex');
    const mine = await this.prisma.pushSubscription.count({ where: { userId } });
    const existing = await this.prisma.pushSubscription.findUnique({ where: { endpointHash } });
    if (existing && existing.userId !== userId) {
      // A browser that changed hands: the new person gets it, the old one loses it.
      await this.prisma.pushSubscription.delete({ where: { id: existing.id } });
    } else if (!existing && mine >= NOTIFY_LIMITS.devicesMax)
      throw new ConflictException('too_many_devices');
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpointHash },
      create: {
        id: newId(),
        userId,
        endpoint: input.endpoint,
        endpointHash,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
      update: {
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        lastSeenAt: new Date(),
      },
    });
    return this.toDto(row);
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    const endpointHash = createHash('sha256').update(endpoint).digest('hex');
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpointHash } });
  }

  async devices(userId: string): Promise<PushDeviceDto[]> {
    const rows = await this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async removeDevice(userId: string, id: string): Promise<void> {
    const res = await this.prisma.pushSubscription.deleteMany({ where: { id, userId } });
    if (!res.count) throw new NotFoundException();
  }

  private toDto(row: {
    id: string;
    endpoint: string;
    userAgent: string | null;
    createdAt: Date;
    lastSeenAt: Date;
  }): PushDeviceDto {
    let service = '';
    try {
      service = new URL(row.endpoint).hostname;
    } catch {
      /* stored endpoints were validated */
    }
    return {
      id: row.id,
      service,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- sending

  /** Is somebody looking at this channel right now (a page of theirs shows it and was used in the last minute)? */
  async isFocused(userId: string, channelId: string, now = Date.now()): Promise<boolean> {
    if (!this.rt.started) return false;
    const sockets = await this.rt.socketsIn(userRoom(userId));
    return sockets.some(
      (s) => s.data.focus === channelId && now - s.data.lastActivity < FOCUS_FRESH_MS,
    );
  }

  /**
   * Sends a push to every device of the person, unless they asked for none, are in quiet hours, are looking at the channel,
   * or already got one for it a moment ago. `build` makes the message in the person's language.
   * Returns how many devices were sent to. Never throws.
   */
  async notify(
    userId: string,
    channelId: string | null,
    build: (locale: string) => PushPayload,
    now = Date.now(),
  ): Promise<number> {
    try {
      if (!this.enabled) return 0;
      const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
      if (!subs.length) return 0;
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true, quietHours: true },
      });
      if (!user) return 0;
      const quiet = quietHoursSchema.safeParse(user.quietHours);
      if (quiet.success && inQuietHours(quiet.data, new Date(now))) return 0;
      if (channelId) {
        if (await this.isFocused(userId, channelId, now)) return 0;
        const key = `${userId}:${channelId}`;
        const last = this.lastPush.get(key) ?? 0;
        if (now - last < this.env.NOTIFY_PUSH_COALESCE_SECONDS * 1000) return 0;
        this.lastPush.set(key, now);
        if (this.lastPush.size > 10_000)
          for (const [k, t] of this.lastPush) if (now - t > 60_000) this.lastPush.delete(k);
      }
      const body = JSON.stringify(build(user.locale));
      let sent = 0;
      for (const sub of subs) if (await this.send(sub, body)) sent++;
      return sent;
    } catch (e) {
      this.log.warn(`push failed: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  private async send(
    sub: { id: string; endpoint: string; p256dh: string; auth: string },
    body: string,
  ): Promise<boolean> {
    if (!this.endpointAllowed(sub.endpoint)) {
      await this.prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
      return false;
    }
    try {
      const request = webpush.generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        {
          TTL: 3600,
          urgency: 'normal',
          vapidDetails: {
            subject: this.env.VAPID_SUBJECT!,
            publicKey: this.env.VAPID_PUBLIC_KEY!,
            privateKey: this.env.VAPID_PRIVATE_KEY!,
          },
        },
      );
      const res = await fetch(request.endpoint, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        body: request.body as Buffer,
        redirect: 'error',
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 410) {
        await this.prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
        return false;
      }
      if (!res.ok) {
        this.log.warn(`push service answered ${res.status}`);
        return false;
      }
      await this.prisma.pushSubscription.updateMany({
        where: { id: sub.id },
        data: { lastSeenAt: new Date() },
      });
      return true;
    } catch (e) {
      this.log.warn(`could not reach a push service: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  /** A subscription refused for a reason the caller can show. */
  static invalid(): UnprocessableEntityException {
    return new UnprocessableEntityException('invalid_subscription');
  }
}
