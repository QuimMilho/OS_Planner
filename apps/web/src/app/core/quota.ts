import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { StorageBreakdownDto } from '@os-planner/shared';
import { AuthStore } from './auth-store';

/** Share of the limit at which people are warned; at 100 % nothing more can be stored. */
export const QUOTA_WARN_AT = 0.8;

export type QuotaLevel = 'ok' | 'warn' | 'full';

/**
 * How full the person's storage is. Fed by the server (`GET /api/me/storage`) after each sync
 * cycle and whenever the Settings page opens, so the bar follows what was just uploaded.
 */
@Injectable({ providedIn: 'root' })
export class QuotaStore {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthStore);

  readonly usage = signal<StorageBreakdownDto | null>(null);
  /** The server refused something because it did not fit. Sync clears it after a cycle in which nothing was refused. */
  readonly refused = signal(false);

  readonly fraction = computed(() => {
    const u = this.usage();
    if (!u || !u.limit) return 0;
    return Math.min(1, u.used / u.limit);
  });

  readonly level = computed<QuotaLevel>(() => {
    const u = this.usage();
    if (!u || !u.limit) return 'ok';
    if (this.refused() || u.used >= u.limit) return 'full';
    return this.fraction() >= QUOTA_WARN_AT ? 'warn' : 'ok';
  });

  async refresh(): Promise<void> {
    if (!this.auth.getToken()) return;
    try {
      const usage = await firstValueFrom(this.http.get<StorageBreakdownDto>('/api/me/storage'));
      this.usage.set(usage);
    } catch {
      /* offline: keep what was last known */
    }
  }

  markRefused(): void {
    this.refused.set(true);
  }
}
