import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** "https://a.example.com, http://localhost:4300/" -> ["https://a.example.com", "http://localhost:4300"] (null when an entry is not an http(s) address). */
export function parseOrigins(list: string): string[] | null {
  const origins: string[] = [];
  for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
    try {
      const url = new URL(entry);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      return null;
    }
  }
  return origins;
}

const originList = z
  .string()
  .default('')
  .refine((v) => parseOrigins(v) !== null, 'must be a comma-separated list of http(s) origins such as https://planner.example.com (no wildcards)')
  .transform((v) => parseOrigins(v) ?? []);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public origin of the site, e.g. https://planner.example.com. Used for links in emails. */
  APP_URL: z.url(),

  /**
   * Websites allowed to call this API from another origin (CORS, with cookies). The origin of APP_URL is always allowed.
   * Leave empty when the website and the API share one origin.
   */
  CORS_ORIGINS: originList,
  /**
   * SameSite attribute of the refresh cookie. "strict" works when the website and the API are on the same site
   * (same origin, or subdomains of one domain such as planner.example.com + api.example.com).
   * Only unrelated domains need "none", which requires https.
   */
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
  /** Public address of the API as the browser sees it, if different from the website. Defaults to the apiUrl in the built web app's config.json. */
  OS_PLANNER_API_URL: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim())
    .refine((v) => v === '' || parseOrigins(v)?.length === 1, 'must be one http(s) address such as https://api.example.com')
    .transform((v) => (v === '' ? undefined : parseOrigins(v)![0])),

  DATABASE_URL: z.string().startsWith('mysql://'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_MEDIA_SECRET: z.string().min(32, 'JWT_MEDIA_SECRET must be at least 32 characters'),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional().transform((v) => v || undefined),
  SMTP_PASS: z.string().optional().transform((v) => v || undefined),
  SMTP_SECURE: bool.default(false),
  MAIL_FROM: z.string().default('OS_Planner <no-reply@os-planner.local>'),

  DATA_DIR: z.string().default('./data'),
  MAX_IMAGE_MB: z.coerce.number().positive().default(20),
  MAX_VIDEO_MB: z.coerce.number().positive().default(500),
  USER_QUOTA_MB: z.coerce.number().positive().default(2048),
  /** Default storage of one team (its own notebooks plus all its projects). */
  TEAM_QUOTA_MB: z.coerce.number().positive().default(10240),
  /** Default storage of one project; 0 means the project is limited only by its team. */
  PROJECT_QUOTA_MB: z.coerce.number().min(0).default(0),
  MAX_MEMBERS_PER_TEAM: z.coerce.number().int().positive().default(100),
  MAX_PROJECTS_PER_TEAM: z.coerce.number().int().positive().default(50),
  /** Roles of one team, team and project roles together, @everyone not counted. */
  MAX_ROLES_PER_TEAM: z.coerce.number().int().positive().default(100),
  /** Audit-log entries older than this many days are removed by the nightly job. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),

  /** Instance administrators: comma-separated email addresses. Only a verified address counts. */
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      [...new Set(v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))],
    ),

  /** Bearer token for POST /api/admin/releases. Empty disables the endpoint. */
  RELEASE_TOKEN: z.string().optional().transform((v) => v || undefined),

  /** Directory holding the built Angular app. When present the server serves it at /. */
  WEB_DIST_DIR: z.string().optional().transform((v) => v || undefined),

  /** Set when running behind a reverse proxy so client IPs and https are detected correctly. */
  TRUST_PROXY: bool.default(false),

  /** Chromium/Chrome/Edge binary used to render PDFs. Auto-detected in common locations when unset. */
  CHROME_PATH: z.string().optional().transform((v) => v || undefined),
  /** Needed when Chrome runs as root inside a container without a user namespace. */
  PDF_NO_SANDBOX: bool.default(false),

  /**
   * Redis for running several server instances: realtime events reach people connected to any of them. Unset = one
   * instance (events stay in memory). Example: redis://localhost:6379
   */
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim() || undefined)
    .refine((v) => v === undefined || v.startsWith('redis://') || v.startsWith('rediss://'), 'must start with redis:// or rediss://'),

  /**
   * Web Push (VAPID). Generate a pair with `npx web-push generate-vapid-keys`. Without both keys push is switched off and
   * the website hides the option. VAPID_SUBJECT is a mailto: or https: address the push services can reach you at.
   */
  VAPID_PUBLIC_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  VAPID_PRIVATE_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  VAPID_SUBJECT: z.string().optional().transform((v) => v?.trim() || undefined),
  /** Extra push service origins to accept, besides the browsers' own (Google, Mozilla, Apple, Microsoft). Comma-separated. */
  PUSH_EXTRA_ENDPOINTS: originList,
  /** A person with no activity on any open page for this long counts as away (email "only when I'm away"). */
  NOTIFY_AWAY_SECONDS: z.coerce.number().int().min(0).default(600),
  /** At most one email per chat and person in this time. */
  NOTIFY_EMAIL_INTERVAL_MINUTES: z.coerce.number().min(0).default(15),
  /** At most one push per person and channel in this time. */
  NOTIFY_PUSH_COALESCE_SECONDS: z.coerce.number().int().min(0).default(10),
  /** How often waiting emails are looked at; 0 turns the sender off. */
  NOTIFY_SWEEP_SECONDS: z.coerce.number().int().min(0).default(30),

  /** Turns request throttling off. Only the integration tests set this. */
  THROTTLE_DISABLED: bool.default(false),
}).superRefine((env, ctx) => {
  if (env.COOKIE_SAMESITE === 'none' && !env.APP_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SAMESITE'], message: '"none" needs APP_URL to be https:// (browsers reject SameSite=None cookies that are not Secure)' });
  }
});

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

/** Parses and validates configuration. Throws one readable error listing every problem. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** In development the single repo-level .env is loaded; in production the environment is used as is. */
export function loadDotEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  const file = candidates.find((p) => existsSync(p));
  if (file) process.loadEnvFile(file);
}

/** Push needs both VAPID keys and a contact address. */
export const pushEnabled = (env: Env): boolean => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

export const isHttps = (env: Env): boolean => env.APP_URL.startsWith('https://');

/** True when the address is listed in ADMIN_EMAILS (case-insensitive). The caller must also check that the address is verified. */
export const isAdminEmail = (env: Env, email: string): boolean => env.ADMIN_EMAILS.includes(email.trim().toLowerCase());

/** Per-user storage quota in whole bytes (the setting is in MB and may be fractional). */
export const quotaBytes = (env: Env): number => Math.floor(env.USER_QUOTA_MB * 1024 * 1024);

/** Every browser origin that may call the API: APP_URL plus CORS_ORIGINS. */
export const allowedOrigins = (env: Env): string[] => [...new Set([new URL(env.APP_URL).origin, ...env.CORS_ORIGINS])];
