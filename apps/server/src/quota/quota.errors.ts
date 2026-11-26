import { HttpException, HttpStatus } from '@nestjs/common';
import type { QuotaExceededBody, QuotaScope } from '@os-planner/shared';

/** Something that stores bytes did not fit: `413 { code: 'quota_exceeded', scope, limit, used, requested }`. */
export class QuotaExceeded extends HttpException {
  constructor(scope: QuotaScope, limit: number, used: number, requested: number) {
    const body: QuotaExceededBody = {
      statusCode: 413,
      message: 'quota_exceeded',
      code: 'quota_exceeded',
      scope,
      limit,
      used,
      requested,
    };
    super(body, HttpStatus.PAYLOAD_TOO_LARGE);
  }
}
