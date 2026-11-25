import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AuthResponse, Locale, RegisterInput, Theme, UserDto } from '@notes/shared';

const LAST_USER_KEY = 'notes.lastUser';
const CSRF = { 'X-Requested-With': 'notes' };

/** What a person typed vs what the server rejected; templates show `code` through the translation table. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
  /** The server could not be reached (as opposed to it answering "no"). */
  get offline(): boolean {
    return this.code === 'offline';
  }
}

/**
 * True when a request failed because the server could not be reached, not because it refused. That
 * is status 0 (no network) but also 502/503/504: with no connection, Angular's service worker answers
 * a failed request with a synthetic "504 Gateway Timeout" instead of a network error.
 */
export const isUnreachable = (e: unknown): boolean => e instanceof HttpErrorResponse && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);

/** Turns an HttpErrorResponse into an ApiProblem with a stable machine-readable code. */
export function toProblem(e: unknown): ApiProblem {
  if (e instanceof ApiProblem) return e;
  if (e instanceof HttpErrorResponse) {
    if (isUnreachable(e)) return new ApiProblem(e.status, 'offline');
    const body = e.error as { message?: string | string[] } | null;
    const msg = Array.isArray(body?.message) ? body!.message[0]! : (body?.message ?? 'error');
    return new ApiProblem(e.status, typeof msg === 'string' && /^[a-z0-9_]+$/.test(msg) ? msg : `http_${e.status}`, body);
  }
  return new ApiProblem(-1, 'unknown');
}

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly http = inject(HttpClient);

  /** 'loading' until the first refresh attempt finishes; the router waits for it. */
  readonly status = signal<'loading' | 'anon' | 'authed'>('loading');
  readonly user = signal<UserDto | null>(null);
  readonly userId = computed(() => this.user()?.id ?? null);
  /** True when the app was opened without a connection and has not yet re-authenticated. */
  readonly offlineSession = signal(false);

  /** The access token lives only in memory: nothing for a script to steal from storage. */
  private token: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  getToken(): string | null {
    return this.token;
  }

  /** Called once at startup: resumes the session from the httpOnly refresh cookie. */
  async init(): Promise<void> {
    // A server that never answers must not hold the whole app hostage: after a few seconds, behave as if offline.
    // The timer is cancelled as soon as the refresh settles; left running it would later flip a healthy session offline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(this.status() === 'loading' ? this.resumeOffline() : true), 6000);
    });
    const ok = await Promise.race([this.refresh(), slow]).finally(() => clearTimeout(timer));
    if (!ok && this.status() === 'loading') this.status.set('anon');
  }

  /**
   * Gets a new access token. One refresh at a time per tab, and one across tabs via the Web
   * Locks API, because the refresh token rotates and two simultaneous refreshes race.
   * With no network but a remembered user, the app opens offline from its local database.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        const res = await firstValueFrom(this.http.post<AuthResponse>('/api/auth/refresh', {}, { headers: CSRF }));
        this.apply(res);
        return true;
      } catch (e) {
        const problem = toProblem(e);
        if (problem.offline) return this.resumeOffline();
        this.clear();
        return false;
      }
    };
    return navigator.locks ? navigator.locks.request('notes-token-refresh', run) : run();
  }

  /** No network: trust the last signed-in user so the cached app and local notes keep working. */
  private resumeOffline(): boolean {
    const last = readLastUser();
    if (!last) return false;
    this.user.set(last);
    this.status.set('authed');
    this.offlineSession.set(true);
    return true; // no token; requests will fail until the connection returns
  }

  private apply(res: AuthResponse): void {
    this.token = res.accessToken;
    this.user.set(res.user);
    this.status.set('authed');
    this.offlineSession.set(false);
    try {
      localStorage.setItem(LAST_USER_KEY, JSON.stringify(res.user));
    } catch {
      /* private mode: the offline-resume convenience is simply unavailable */
    }
  }

  private clear(): void {
    this.token = null;
    this.user.set(null);
    this.status.set('anon');
  }

  async login(email: string, password: string): Promise<void> {
    this.apply(await this.post<AuthResponse>('/api/auth/login', { email, password }));
  }

  async register(input: RegisterInput): Promise<void> {
    this.apply(await this.post<AuthResponse>('/api/auth/register', input));
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}, { headers: CSRF }));
    } catch {
      /* the server session expires on its own; the local state is cleared regardless */
    }
    try {
      localStorage.removeItem(LAST_USER_KEY);
    } catch {
      /* ignore */
    }
    this.clear();
  }

  patchUser(user: UserDto): void {
    this.user.set(user);
    try {
      localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
    } catch {
      /* ignore */
    }
  }

  async updateProfile(changes: { displayName?: string; locale?: Locale; theme?: Theme }): Promise<void> {
    // Applied locally first so language/theme switch instantly, even offline.
    const current = this.user();
    if (current) this.patchUser({ ...current, ...changes });
    if (this.token) this.patchUser(await firstValueFrom(this.http.patch<UserDto>('/api/me', changes)));
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    try {
      return await firstValueFrom(this.http.post<T>(url, body));
    } catch (e) {
      throw toProblem(e);
    }
  }
}

function readLastUser(): UserDto | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? (JSON.parse(raw) as UserDto) : null;
  } catch {
    return null;
  }
}
