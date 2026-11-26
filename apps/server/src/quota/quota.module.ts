import { Global, Module } from '@nestjs/common';
import { EnvQuotaPolicy, QuotaPolicy } from './quota.policy.js';
import { QuotaService } from './quota.service.js';

/** Global: every module that stores bytes asks the same QuotaService. Replace `QuotaPolicy` to change where defaults come from. */
@Global()
@Module({
  providers: [{ provide: QuotaPolicy, useClass: EnvQuotaPolicy }, QuotaService],
  exports: [QuotaService, QuotaPolicy],
})
export class QuotaModule {}
