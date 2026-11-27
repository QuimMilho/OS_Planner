import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler/dist/throttler.guard.interface.js';
import { ENV, type Env } from '../config/env.js';

/**
 * Request throttling (per address, per route, per minute) with every limit multiplied by RATE_LIMIT_FACTOR: one setting to give
 * a busy instance (many people behind one office NAT) more room, or a small one less, without changing each route's limit.
 */
@Injectable()
export class ScaledThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {
    super(options, storage, reflector);
  }

  protected override handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const factor = this.env.RATE_LIMIT_FACTOR;
    return super.handleRequest(
      factor === 1
        ? requestProps
        : { ...requestProps, limit: Math.max(1, Math.round(requestProps.limit * factor)) },
    );
  }
}
