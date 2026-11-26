import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/auth.decorators.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RealtimeServer } from './realtime/realtime.server.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeServer,
  ) {}

  /** For container orchestrators and uptime checks: 200 only when the database answers. `realtime` is "degraded" when the socket server or its Redis is not working (the API still is). */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, realtime: this.realtime.health };
    } catch {
      throw new ServiceUnavailableException({ ok: false });
    }
  }
}
