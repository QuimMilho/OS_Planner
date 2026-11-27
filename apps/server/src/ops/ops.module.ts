import { Module } from '@nestjs/common';
import { VoiceModule } from '../voice/voice.module.js';
import { HealthController, HealthService } from './health.js';
import { HttpStats } from './http-stats.js';
import { MetricsController, MetricsGuard } from './metrics.js';

/** Running the instance: health, metrics, and the per-request id, log line and counters (see app.setup). */
@Module({
  imports: [VoiceModule],
  controllers: [HealthController, MetricsController],
  providers: [HttpStats, HealthService, MetricsGuard],
  exports: [HttpStats],
})
export class OpsModule {}
