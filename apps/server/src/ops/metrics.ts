import { timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { TokenService } from '../auth/token.service.js';
import { Public } from '../common/auth.decorators.js';
import { Authz } from '../common/authz.js';
import { CollabServer } from '../collab/collab.server.js';
import { CollabService } from '../collab/collab.service.js';
import { ENV, isAdminEmail, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeServer } from '../realtime/realtime.server.js';
import { DURATION_BUCKETS, HttpStats } from './http-stats.js';

/**
 * /api/metrics is for the people who run the instance: an instance administrator's access token, or the METRICS_TOKEN bearer that
 * a Prometheus scraper can be given (an access token expires every few minutes). Everybody else gets 404, like the admin area.
 */
@Injectable()
export class MetricsGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given) throw new NotFoundException();
    if (this.env.METRICS_TOKEN) {
      const a = Buffer.from(given);
      const b = Buffer.from(this.env.METRICS_TOKEN);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    const auth = await this.tokens.verifyAccess(given);
    if (!auth) throw new NotFoundException();
    const user = await this.prisma.user.findUnique({
      where: { id: auth.id },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt || !isAdminEmail(this.env, user.email))
      throw new NotFoundException();
    return true;
  }
}

type Sample = [labels: Record<string, string | number>, value: number];

/** One metric in the Prometheus text format. */
function metric(
  name: string,
  type: 'gauge' | 'counter' | 'histogram',
  help: string,
  samples: Sample[],
): string {
  const label = (l: Record<string, string | number>) => {
    const parts = Object.entries(l).map(
      ([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    );
    return parts.length ? `{${parts.join(',')}}` : '';
  };
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    ...samples.map(([l, v]) => `${name}${label(l)} ${Number.isFinite(v) ? v : 0}`),
  ].join('\n');
}

@Controller('metrics')
export class MetricsController {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor(
    private readonly http: HttpStats,
    private readonly realtime: RealtimeServer,
    private readonly collab: CollabServer,
    private readonly collabService: CollabService,
    private readonly prisma: PrismaService,
  ) {
    this.loop.enable();
  }

  /** Prometheus text format: the process, HTTP, realtime, co-editing and the work waiting in queues. `?gc=1` collects garbage first (with node --expose-gc; the soak test uses it). */
  @Public()
  @SkipThrottle()
  @UseGuards(MetricsGuard)
  @Authz({ scope: 'admin', note: 'or the METRICS_TOKEN bearer (for a scraper)' })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Get()
  async metrics(
    @Query({ schema: z.object({ gc: z.enum(['0', '1']).optional() }) }) q: { gc?: '0' | '1' },
  ): Promise<string> {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (q.gc === '1' && gc) gc();
    const mem = process.memoryUsage();
    const resources = new Map<string, number>();
    for (const type of process.getActiveResourcesInfo())
      resources.set(type, (resources.get(type) ?? 0) + 1);
    const rt = this.realtime.started
      ? this.realtime.snapshot()
      : {
          sockets: 0,
          rooms: 0,
          users: 0,
          redis: false,
          dropped: { unknown: 0, invalid: 0, rateLimited: 0 },
          refused: {},
        };
    const co = this.collab.snapshot();
    const counters = this.collabService.stats_;
    const [digest] = await this.prisma.$queryRaw<
      { n: bigint | null }[]
    >`SELECT SUM(pendingCount) AS n FROM EmailDigestState`;
    const due = await this.prisma.externalCalendar.count({
      where: { enabled: true, nextSyncAt: { lte: new Date() } },
    });
    const voice = await this.prisma.voiceParticipant.count();

    const httpCounts: Sample[] = [...this.http.counts].map(([k, v]) => {
      const [method, route, status] = k.split(' ');
      return [{ method: method!, route: route!, status: status! }, v];
    });
    const histogram: string[] = [
      '# HELP os_planner_http_request_duration_seconds Time to answer an API request.',
      '# TYPE os_planner_http_request_duration_seconds histogram',
    ];
    for (const [series, buckets] of this.http.buckets) {
      const [method, route] = series.split(' ');
      const l = `method="${method}",route="${route}"`;
      DURATION_BUCKETS.forEach((le, i) =>
        histogram.push(
          `os_planner_http_request_duration_seconds_bucket{${l},le="${le}"} ${buckets[i]}`,
        ),
      );
      const count = [...this.http.counts]
        .filter(([k]) => k.startsWith(`${series} `))
        .reduce((a, [, v]) => a + v, 0);
      histogram.push(`os_planner_http_request_duration_seconds_bucket{${l},le="+Inf"} ${count}`);
      histogram.push(
        `os_planner_http_request_duration_seconds_sum{${l}} ${this.http.sums.get(series) ?? 0}`,
      );
      histogram.push(`os_planner_http_request_duration_seconds_count{${l}} ${count}`);
    }

    return [
      metric('process_resident_memory_bytes', 'gauge', 'Resident memory of the server process.', [
        [{}, mem.rss],
      ]),
      metric('nodejs_heap_size_used_bytes', 'gauge', 'V8 heap in use.', [[{}, mem.heapUsed]]),
      metric('nodejs_heap_size_total_bytes', 'gauge', 'V8 heap reserved.', [[{}, mem.heapTotal]]),
      metric(
        'nodejs_external_memory_bytes',
        'gauge',
        'Memory of objects outside the V8 heap (buffers).',
        [[{}, mem.external]],
      ),
      metric('process_uptime_seconds', 'gauge', 'Seconds since the process started.', [
        [{}, Math.round(process.uptime())],
      ]),
      metric(
        'nodejs_eventloop_lag_p99_seconds',
        'gauge',
        'Event loop delay, 99th percentile since start.',
        [[{}, this.loop.percentile(99) / 1e9]],
      ),
      metric(
        'nodejs_active_resources',
        'gauge',
        'Handles keeping the event loop alive, by type (timers, sockets...).',
        [...resources].map(([type, n]) => [{ type }, n]),
      ),
      metric(
        'os_planner_http_requests_total',
        'counter',
        'API requests answered, by route and status class.',
        httpCounts,
      ),
      histogram.join('\n'),
      metric('os_planner_realtime_sockets', 'gauge', 'Realtime connections on this instance.', [
        [{}, rt.sockets],
      ]),
      metric('os_planner_realtime_rooms', 'gauge', 'Realtime rooms on this instance.', [
        [{}, rt.rooms],
      ]),
      metric('os_planner_realtime_users', 'gauge', 'People connected to this instance.', [
        [{}, rt.users],
      ]),
      metric(
        'os_planner_realtime_dropped_total',
        'counter',
        'Client events dropped, by reason.',
        Object.entries(rt.dropped).map(([reason, n]) => [{ reason }, n]),
      ),
      metric(
        'os_planner_realtime_refused_total',
        'counter',
        'Connections refused at the handshake, by reason.',
        Object.entries(rt.refused).map(([reason, n]) => [{ reason }, n as number]),
      ),
      metric(
        'os_planner_collab_documents',
        'gauge',
        'Pages open for co-editing on this instance.',
        [[{}, co.documents]],
      ),
      metric('os_planner_collab_connections', 'gauge', 'Co-editing connections on this instance.', [
        [{}, co.connections],
      ]),
      metric(
        'os_planner_collab_stores_total',
        'counter',
        'Pages written to the database by co-editing.',
        [[{}, counters.stores]],
      ),
      metric(
        'os_planner_collab_store_seconds_total',
        'counter',
        'Time spent writing co-edited pages.',
        [[{}, counters.storeSeconds]],
      ),
      metric(
        'os_planner_collab_refused_total',
        'counter',
        'Co-edited pages not written, by reason.',
        Object.entries(counters.refused).map(([reason, n]) => [{ reason }, n]),
      ),
      metric(
        'os_planner_queue_email_digest_pending',
        'gauge',
        'Notifications waiting to go out by email.',
        [[{}, Number(digest?.n ?? 0)]],
      ),
      metric('os_planner_queue_calendars_due', 'gauge', 'Followed calendars due for a refresh.', [
        [{}, due],
      ]),
      metric(
        'os_planner_voice_participants',
        'gauge',
        'People in voice channels (all instances).',
        [[{}, voice]],
      ),
      '',
    ].join('\n');
  }
}
