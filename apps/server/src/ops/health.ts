import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../common/auth.decorators.js';
import { Authz } from '../common/authz.js';
import { ENV, voiceEnabled, type Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeServer } from '../realtime/realtime.server.js';
import { LiveKitService } from '../voice/livekit.service.js';

export type Component = 'ok' | 'degraded' | 'down';

export interface HealthDto {
  ok: boolean;
  db: Component;
  storage: Component;
  realtime: Component;
  mail: Component;
  /** Only with REDIS_URL. */
  redis?: Component;
  /** Only when voice is configured. */
  livekit?: Component;
}

const CACHE_MS = 60_000;

/**
 * What /api/health reports. The database and the storage folder are needed to answer at all (503 without them); the rest is
 * reported (`degraded`) without failing, so a mail outage does not get the container restarted. The slow checks (mail, media
 * server) are remembered for a minute: health checks every few seconds must not become a load on the mail server.
 */
@Injectable()
export class HealthService {
  private cached = new Map<string, { at: number; value: Component }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeServer,
    private readonly mail: MailService,
    private readonly livekit: LiveKitService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async remembered(key: string, check: () => Promise<boolean>): Promise<Component> {
    const hit = this.cached.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value: Component = (await check().catch(() => false)) ? 'ok' : 'degraded';
    this.cached.set(key, { at: Date.now(), value });
    return value;
  }

  async check(): Promise<HealthDto> {
    const db: Component = await this.prisma.$queryRaw`SELECT 1`.then(
      () => 'ok' as const,
      () => 'down' as const,
    );
    const storage: Component = await access(resolve(this.env.DATA_DIR), constants.W_OK).then(
      () => 'ok' as const,
      () => 'down' as const,
    );
    const realtime: Component = !this.realtime.started ? 'down' : this.realtime.health;
    const mail = await this.remembered('mail', () =>
      typeof this.mail.verify === 'function' ? this.mail.verify() : Promise.resolve(true),
    );
    const out: HealthDto = { ok: db === 'ok' && storage === 'ok', db, storage, realtime, mail };
    if (this.env.REDIS_URL) out.redis = this.realtime.health === 'ok' ? 'ok' : 'down';
    if (voiceEnabled(this.env))
      out.livekit = await this.remembered(
        'livekit',
        async () => (await this.livekit.listRooms(), true),
      );
    return out;
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * For container orchestrators and uptime checks: 200 while the database and the storage answer. `?strict=1` also fails while the
   * realtime socket server is down (what the image's HEALTHCHECK asks). Nothing secret: states only.
   */
  @Public()
  @SkipThrottle()
  @Authz({ scope: 'public', note: 'component states only (ok, degraded, down)' })
  @Get()
  async check(
    @Query({ schema: z.object({ strict: z.enum(['0', '1']).optional() }) })
    q: {
      strict?: '0' | '1';
    },
  ): Promise<HealthDto> {
    const h = await this.health.check();
    if (!h.ok || (q.strict === '1' && h.realtime === 'down'))
      throw new ServiceUnavailableException(h);
    return h;
  }
}
