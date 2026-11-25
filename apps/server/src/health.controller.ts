import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/auth.decorators.js';
import { PrismaService } from './prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** For container orchestrators and uptime checks: 200 only when the database answers. */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException({ ok: false });
    }
  }
}
