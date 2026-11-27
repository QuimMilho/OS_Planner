import { Inject, Injectable } from '@nestjs/common';
import { ENV, icsAllowHttp, type Env } from '../config/env.js';
import {
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
  type Transport,
} from './safe-fetch.js';

/** Reads calendars from addresses people gave, within the operator's settings. `resolve` and `transport` are what tests replace. */
@Injectable()
export class IcsFetcher {
  resolve: ((host: string) => Promise<string[]>) | undefined;
  transport: Transport | undefined;
  /** Smaller limits for tests. */
  limits: Pick<SafeFetchOptions, 'maxBytes' | 'timeoutMs' | 'maxRedirects'> = {};

  constructor(@Inject(ENV) private readonly env: Env) {}

  fetch(
    url: string,
    conditional?: { etag?: string | null; lastModified?: string | null },
  ): Promise<SafeFetchResult> {
    const options: SafeFetchOptions = {
      allowHttp: icsAllowHttp(this.env),
      privateAllowlist: this.env.ICS_PRIVATE_ALLOWLIST,
      ...this.limits,
      etag: conditional?.etag ?? null,
      lastModified: conditional?.lastModified ?? null,
    };
    if (this.resolve) options.resolve = this.resolve;
    if (this.transport) options.transport = this.transport;
    return safeFetch(url, options);
  }
}
