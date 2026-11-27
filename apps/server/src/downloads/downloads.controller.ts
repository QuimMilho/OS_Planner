import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { publishReleaseSchema, type DownloadsDto, type PublishReleaseInput, type ReleaseManifest } from '@os-planner/shared';
import { Public } from '../common/auth.decorators.js';
import { ENV, type Env } from '../config/env.js';
import { DownloadsService } from './downloads.service.js';
import { Authz } from '../common/authz.js';

/**
 * Publishing is for the build pipeline, not for users, so it is guarded by one shared secret
 * rather than accounts. With no secret configured the endpoints do not exist.
 */
@Injectable()
export class ReleaseTokenGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.env.RELEASE_TOKEN;
    if (!expected) throw new NotFoundException();
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}

@Controller()
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  /** What the website's download page renders. Public. */
  @Public()
  @Authz({ scope: 'public' })
  @Get('downloads')
  current(): Promise<DownloadsDto> {
    return this.downloads.current();
  }

  /** Raw-body upload of one installer/metadata file. Streams to disk. */
  @Public()
  @UseGuards(ReleaseTokenGuard)
  @Authz({ scope: 'release' })
  @Put('admin/releases/files/:name')
  upload(@Param('name') name: string, @Req() req: Request) {
    return this.downloads.receiveFile(name, req);
  }

  /** Declares which uploaded files form the current release. */
  @Public()
  @UseGuards(ReleaseTokenGuard)
  @HttpCode(200)
  @Authz({ scope: 'release' })
  @Post('admin/releases')
  publish(@Body({ schema: publishReleaseSchema }) body: PublishReleaseInput): Promise<ReleaseManifest> {
    return this.downloads.publish(body);
  }
}
