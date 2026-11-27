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
  /** `production` turns on the production checks (placeholder secrets refused, JSON logs, plain http calendars refused). */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Port the server listens on (inside the container: 3000). */
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

  /** The MySQL database: mysql://user:password@host:3306/database. In production a default password is refused. */
  DATABASE_URL: z.string().startsWith('mysql://'),

  /** Signs the short-lived access tokens (at least 32 characters). Changing it signs everybody out of their current tab until it refreshes. */
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  /** Signs the media tokens that let <img> and <video> load files (at least 32 characters, not the same as JWT_ACCESS_SECRET). */
  JWT_MEDIA_SECRET: z.string().min(32, 'JWT_MEDIA_SECRET must be at least 32 characters'),

  /** The mail server (verification, password reset, invites, notification email). mailpit in development. */
  SMTP_HOST: z.string().default('localhost'),
  /** Its port: 587 (STARTTLS) or 465 (with SMTP_SECURE=true) for most providers. */
  SMTP_PORT: z.coerce.number().int().default(1025),
  /** Login of the mail server, if it needs one. */
  SMTP_USER: z.string().optional().transform((v) => v || undefined),
  /** Password of the mail server. */
  SMTP_PASS: z.string().optional().transform((v) => v || undefined),
  /** true for implicit TLS (port 465); false lets the connection upgrade with STARTTLS. */
  SMTP_SECURE: bool.default(false),
  /** Sender of every email the server sends. */
  MAIL_FROM: z.string().default('OS_Planner <no-reply@os-planner.local>'),

  /** Where uploaded files (media, attachments) and desktop releases are kept. Back it up together with the database. */
  DATA_DIR: z.string().default('./data'),
  /** Largest image one upload may be, in MB. */
  MAX_IMAGE_MB: z.coerce.number().positive().default(20),
  /** Largest video one upload may be, in MB (the reverse proxy must accept at least this much). */
  MAX_VIDEO_MB: z.coerce.number().positive().default(500),
  /** Default storage of one person (their own notebooks, files and messages), in MB. */
  USER_QUOTA_MB: z.coerce.number().positive().default(2048),
  /** Default storage of one team (its own notebooks plus all its projects). */
  TEAM_QUOTA_MB: z.coerce.number().positive().default(10240),
  /** Default storage of one project; 0 means the project is limited only by its team. */
  PROJECT_QUOTA_MB: z.coerce.number().min(0).default(0),
  /** Most people one team may have (an admin can set another number for a team). */
  MAX_MEMBERS_PER_TEAM: z.coerce.number().int().positive().default(100),
  /** Most projects and sub-projects one team may have. */
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
   * Co-editing (path /api/collab): a page is written to the database this long after the last edit (and at least this
   * often while people keep typing). Shorter means search and exports see edits sooner, longer means fewer writes.
   */
  COLLAB_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(2000),
  /** A page being typed in without a pause is still written at least this often. */
  COLLAB_MAX_DEBOUNCE_MS: z.coerce.number().int().min(0).max(300_000).default(10_000),
  /** Builds the live document of pages that predate co-editing in the background at start-up (otherwise each is built when first opened). */
  COLLAB_MIGRATE_ON_START: bool.default(true),
  /** How often open co-editing connections are checked against what the person may still do (events close them at once; this is the backstop). */
  COLLAB_RECHECK_MS: z.coerce.number().int().min(1000).max(600_000).default(20_000),

  /**
   * Web Push (VAPID). Generate a pair with `npx web-push generate-vapid-keys`. Without both keys push is switched off and
   * the website hides the option. VAPID_SUBJECT is a mailto: or https: address the push services can reach you at.
   */
  VAPID_PUBLIC_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  /** The private half of the VAPID key pair (keep it secret; changing it means every device subscribes again). */
  VAPID_PRIVATE_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  /** A mailto: or https: address the push services can reach the instance operator at. */
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

  /**
   * Calendars other people publish (ICS addresses a person follows) may be fetched over plain http://. Default: allowed outside
   * production, refused in production (an address that starts with webcal: then uses https only).
   */
  ICS_ALLOW_HTTP: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .pipe(bool.optional()),
  /**
   * Hosts the calendar fetcher may reach even though they are on a private network (it refuses those otherwise, so a person cannot make
   * the server read your internal services). Comma-separated: host, or host:port, or an IP address. Example: calendar.corp.local.
   */
  ICS_PRIVATE_ALLOWLIST: z
    .string()
    .default('')
    .transform((v) => [...new Set(v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))]),
  /** Storage one person's followed calendars may take together, in MB (a refresh that would exceed it is refused). */
  EXTERNAL_CALENDAR_MAX_MB: z.coerce.number().positive().default(5),

  /**
   * Voice and video channels need a LiveKit media server (https://livekit.io, Apache-2.0). Without all three of URL, key and secret the
   * feature is off and the website shows no voice option. LIVEKIT_URL is the address browsers connect to (wss://…); LIVEKIT_API_URL is
   * where THIS server reaches LiveKit's API when that differs (http://livekit:7880 inside docker); default: LIVEKIT_URL with https.
   * The key and secret are the ones in LiveKit's own config (`keys:`); the secret must be at least 32 characters.
   */
  LIVEKIT_URL: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().replace(/\/+$/, '') || undefined)
    .refine((v) => v === undefined || /^wss?:\/\/[^/\s]+$/i.test(v), 'must be a ws:// or wss:// address such as wss://voice.example.com'),
  /** Where this server reaches LiveKit's API, when that differs from LIVEKIT_URL (http://livekit:7880 inside docker). */
  LIVEKIT_API_URL: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().replace(/\/+$/, '') || undefined)
    .refine((v) => v === undefined || /^https?:\/\/[^/\s]+$/i.test(v), 'must be an http(s) address such as http://livekit:7880'),
  /** The API key of LiveKit's config (`keys:`). */
  LIVEKIT_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  /** Its secret (at least 32 characters); the same value in LiveKit's config. */
  LIVEKIT_API_SECRET: z.string().optional().transform((v) => v?.trim() || undefined),
  /** Most people in one voice channel unless the channel sets its own limit. */
  VOICE_MAX_PARTICIPANTS: z.coerce.number().int().min(1).max(500).default(25),
  /** Most people in all voice channels of one team at once (an admin can set another number for a team). */
  VOICE_TEAM_MAX_PARTICIPANTS: z.coerce.number().int().min(1).max(100_000).default(100),
  /** How often the server compares who is in voice channels with the media server and re-checks their permissions; 0 turns it off. */
  VOICE_CHECK_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),

  /** Turns request throttling off. Only the integration tests set this. */
  THROTTLE_DISABLED: bool.default(false),
  /**
   * Multiplies every request limit (each route has its own per address and minute, 300 for the rest; see README "Rate limits").
   * 2 gives everybody twice as much room (many people behind one address), 0.5 half.
   */
  RATE_LIMIT_FACTOR: z.coerce.number().positive().max(100).default(1),

  /** How much the server logs: error, warn, log (the default: requests, jobs, warnings), debug or verbose. */
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  /** `json` (one JSON object per line, for a log collector; the default in production) or `text` (for people; the default otherwise). */
  LOG_FORMAT: z.enum(['text', 'json']).optional(),
  /** One line per API request (id, method, path without its query string and secrets, status, time, who). */
  LOG_REQUESTS: bool.default(true),
  /** Bearer token a metrics scraper (Prometheus) uses for /api/metrics. Unset: only instance administrators' tokens are accepted. At least 32 characters. */
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .refine((v) => v === undefined || v.length >= 32, 'METRICS_TOKEN must be at least 32 characters'),
}).superRefine((env, ctx) => {
  const voice = [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET];
  if (voice.some(Boolean) && !voice.every(Boolean)) {
    ctx.addIssue({ code: 'custom', path: ['LIVEKIT_URL'], message: 'voice needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together (or none of them)' });
  }
  if (env.LIVEKIT_API_SECRET && env.LIVEKIT_API_SECRET.length < 32) {
    ctx.addIssue({ code: 'custom', path: ['LIVEKIT_API_SECRET'], message: 'LIVEKIT_API_SECRET must be at least 32 characters' });
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.APP_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SAMESITE'], message: '"none" needs APP_URL to be https:// (browsers reject SameSite=None cookies that are not Secure)' });
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_MEDIA_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['JWT_MEDIA_SECRET'], message: 'JWT_MEDIA_SECRET must differ from JWT_ACCESS_SECRET' });
  }
  if (env.NODE_ENV === 'production') {
    for (const [name, value] of placeholderCandidates(env)) {
      if (value && isPlaceholder(value))
        ctx.addIssue({ code: 'custom', path: [name], message: `${name} is still a placeholder (like the one in .env.example): generate a real one, e.g. node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` });
    }
    const dbPassword = (() => {
      try {
        return decodeURIComponent(new URL(env.DATABASE_URL).password);
      } catch {
        return '';
      }
    })();
    if (DEFAULT_DB_PASSWORDS.has(dbPassword.toLowerCase()))
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'the database password is a default one: set MYSQL_PASSWORD (and change the database user\'s password, see README "Secrets")' });
  }
});

/** Values that are clearly not secrets: the placeholders of .env.example, and the usual stand-ins. */
export const isPlaceholder = (value: string): boolean =>
  /change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_ ]?secret|^(.)\1+$|^(secret|password|test|example)$/i.test(value);
const DEFAULT_DB_PASSWORDS = new Set(['', 'notes', 'root', 'password', 'mysql', 'changeme']);
const placeholderCandidates = (env: { [k: string]: unknown }): [string, string | undefined][] =>
  ['JWT_ACCESS_SECRET', 'JWT_MEDIA_SECRET', 'RELEASE_TOKEN', 'LIVEKIT_API_SECRET', 'VAPID_PRIVATE_KEY', 'METRICS_TOKEN', 'SMTP_PASS'].map((k) => [k, env[k] as string | undefined]);

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

/** May followed calendars be fetched over http://? */
export const icsAllowHttp = (env: Env): boolean => env.ICS_ALLOW_HTTP ?? env.NODE_ENV !== 'production';

/** The address people give to other calendar apps: the API's own origin (calendar apps do not run the website). */
export const feedBase = (env: Env): string => (env.OS_PLANNER_API_URL ?? env.APP_URL).replace(/\/+$/, '');

/** Push needs both VAPID keys and a contact address. */
export const pushEnabled = (env: Env): boolean => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

/** Voice and video channels are on when the media server is configured. */
export const voiceEnabled = (env: Env): boolean => Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);

/** The browser origins of the media server (signalling over ws(s), its small http API on the same host), for the CSP. */
export const voiceOrigins = (env: Env): string[] => {
  if (!voiceEnabled(env)) return [];
  const url = new URL(env.LIVEKIT_URL!);
  const secure = url.protocol === 'wss:';
  return [`${secure ? 'wss' : 'ws'}://${url.host}`, `${secure ? 'https' : 'http'}://${url.host}`];
};

export const isHttps = (env: Env): boolean => env.APP_URL.startsWith('https://');

/** JSON lines in production unless LOG_FORMAT says otherwise. */
export const logFormat = (env: Env): 'text' | 'json' => env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'text');

/** True when the address is listed in ADMIN_EMAILS (case-insensitive). The caller must also check that the address is verified. */
export const isAdminEmail = (env: Env, email: string): boolean => env.ADMIN_EMAILS.includes(email.trim().toLowerCase());

/** Per-user storage quota in whole bytes (the setting is in MB and may be fractional). */
export const quotaBytes = (env: Env): number => Math.floor(env.USER_QUOTA_MB * 1024 * 1024);

/** Every browser origin that may call the API: APP_URL plus CORS_ORIGINS. */
export const allowedOrigins = (env: Env): string[] => [...new Set([new URL(env.APP_URL).origin, ...env.CORS_ORIGINS])];
