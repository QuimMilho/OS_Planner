import { readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { LIMITS } from '@notes/shared';
import { allowedOrigins, isHttps, parseOrigins, type Env } from './config/env.js';

/**
 * The origin the website's API calls go to when it is not this server's own. Taken from NOTES_API_URL, else from the
 * apiUrl in the built web app's config.json (so one setting serves the web build and the server). Read at start-up.
 */
export function apiOrigin(env: Env): string | undefined {
  if (env.NOTES_API_URL) return env.NOTES_API_URL;
  if (!env.WEB_DIST_DIR) return undefined;
  try {
    const { apiUrl } = JSON.parse(readFileSync(join(resolve(env.WEB_DIST_DIR), 'config.json'), 'utf8')) as { apiUrl?: unknown };
    return typeof apiUrl === 'string' ? parseOrigins(apiUrl)?.[0] : undefined;
  } catch {
    return undefined; // no config.json: the API is on the website's own origin
  }
}

/** The origin of an Origin/Referer header value, or '' when absent or unreadable. */
function originOf(value: string | undefined): string {
  try {
    return value ? new URL(value).origin : '';
  } catch {
    return '';
  }
}

/**
 * Everything that makes the app behave like the real server. Shared by main.ts and the
 * integration tests so tests exercise the same prefix, parsers, pipes and security headers.
 */
export function configureApp(app: INestApplication, env: Env): void {
  const express = app as NestExpressApplication;
  const https = isHttps(env);

  if (env.TRUST_PROXY) express.set('trust proxy', 1);
  express.disable('x-powered-by');

  app.setGlobalPrefix('api');

  // Websites on other origins (CORS_ORIGINS) may call the API with the refresh cookie. Exact origins only, never "*".
  app.enableCors({
    origin: allowedOrigins(env),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 600,
  });
  const api = apiOrigin(env);
  const apiSources = api && api !== new URL(env.APP_URL).origin ? [api] : [];

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Angular Material and the editor set inline styles at runtime.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', ...apiSources],
          mediaSrc: ["'self'", 'blob:', ...apiSources],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", ...apiSources],
          frameSrc: ['https://www.youtube-nocookie.com'],
          workerSrc: ["'self'", 'blob:'],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(https ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      // The app embeds YouTube players, which a strict COEP would block.
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: https,
    }),
  );
  // <img>/<video> load media with plain requests, which helmet's default Cross-Origin-Resource-Policy (same-origin) would
  // block when the website is on another origin. Only the websites this API trusts (APP_URL, CORS_ORIGINS) may embed it,
  // judged by the Origin/Referer the browser sends (its default is to send the origin).
  const embedders = new Set(allowedOrigins(env));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/media/')) {
      res.vary('Referer');
      if (embedders.has(originOf(req.get('origin') ?? req.get('referer')))) res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    next();
  });
  app.use(cookieParser());

  // Pages are sent as one JSON body (documents are capped at LIMITS.docMaxBytes).
  express.useBodyParser('json', { limit: LIMITS.docMaxBytes + 512 * 1024 });

  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  serveDownloads(express, env);
  if (env.WEB_DIST_DIR) serveWeb(express, resolve(env.WEB_DIST_DIR));
}

/**
 * The desktop installers and the metadata files electron-updater polls. Versioned file names make
 * the installers safe to cache forever; the metadata and manifest must always be revalidated.
 */
function serveDownloads(app: NestExpressApplication, env: Env): void {
  app.useStaticAssets(join(resolve(env.DATA_DIR), 'downloads'), {
    prefix: '/downloads',
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res, path) => {
      if (/\.ya?ml$/i.test(path) || path.endsWith('manifest.json')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  });
}

/** Files the Angular service worker (and the browser) must always revalidate, or updates never arrive. */
const NEVER_CACHE = new Set(['index.html', 'ngsw.json', 'ngsw-worker.js', 'safety-worker.js', 'manifest.webmanifest', 'config.json']);

/**
 * Serves the built Angular app from the same origin as the API. Unknown paths without a file
 * extension get index.html so deep links work; a missing asset stays a real 404.
 */
function serveWeb(app: NestExpressApplication, dir: string): void {
  app.useStaticAssets(dir, {
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res, path) => {
      const name = basename(path);
      res.setHeader(
        'Cache-Control',
        NEVER_CACHE.has(name) ? 'no-cache' : /[.-][A-Z0-9]{8}\./i.test(name) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      );
    },
  });

  const indexHtml = join(dir, 'index.html');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/downloads')) return next();
    if (extname(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (err) => err && next());
  });
}
