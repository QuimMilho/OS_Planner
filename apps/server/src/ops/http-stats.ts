import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { scrub } from '../common/scrub.js';

/** Upper bounds (seconds) of the request-duration histogram, as Prometheus expects them. */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];

/** The path of a request with what identifies a resource taken out, so the counters stay few: `/api/teams/:id/members`. */
export function routeOf(path: string): string {
  return path
    .split('?')[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/(feeds|links|s|invite)\/[^/]+/g, '/$1/:secret')
    .replace(/\/[^/]*\.(ics|png|jpe?g|webp|gif|mp4|webm|js|css|map|svg|woff2?)$/i, '/:file');
}

/** Request counts and durations, per method, route and status class, since the instance started. */
@Injectable()
export class HttpStats {
  readonly counts = new Map<string, number>();
  readonly buckets = new Map<string, number[]>();
  readonly sums = new Map<string, number>();
  started = Date.now();

  observe(method: string, route: string, status: number, seconds: number): void {
    const key = `${method} ${route} ${Math.floor(status / 100)}xx`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const series = `${method} ${route}`;
    const b = this.buckets.get(series) ?? DURATION_BUCKETS.map(() => 0);
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) b[i]!++;
    });
    this.buckets.set(series, b);
    this.sums.set(series, (this.sums.get(series) ?? 0) + seconds);
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Gives each request an id (the caller's `X-Request-Id` when it is a plain token, else a new one), answers with it, counts the
 * request, and logs one line when it ends: method, path without its query string and with secrets taken out, status, time, and who.
 */
export function requestContext(stats: HttpStats, logRequests: boolean) {
  const log = new Logger('HTTP');
  return (
    req: Request & { id?: string; user?: { id?: string } },
    res: Response,
    next: NextFunction,
  ): void => {
    const given = req.get('x-request-id');
    const id = given && SAFE_ID.test(given) ? given : randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const path = req.originalUrl.split('?')[0] ?? '';
      if (!path.startsWith('/api')) return; // the website's files and /downloads are not the API
      stats.observe(req.method, routeOf(path), res.statusCode, seconds);
      if (logRequests && path !== '/api/health')
        log.log({
          msg: 'request',
          id,
          method: req.method,
          path: scrub(path),
          status: res.statusCode,
          ms: Math.round(seconds * 10_000) / 10,
          ...(req.user?.id ? { user: req.user.id } : {}),
        });
    });
    next();
  };
}
