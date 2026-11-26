import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  changePasswordSchema,
  idSchema,
  updateMeSchema,
  type SessionDto,
  type StorageBreakdownDto,
  type UpdateMeInput,
  type UserDto,
} from '@os-planner/shared';
import type { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { QuotaService } from '../quota/quota.service.js';
import { UsersService } from './users.service.js';

@Controller('me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return this.users.get(user.id);
  }

  /** Settings → Storage: usage and limit with the split by kind. */
  @Get('storage')
  storage(@CurrentUser() user: AuthUser): Promise<StorageBreakdownDto> {
    return this.quota.breakdown('user', user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body({ schema: updateMeSchema }) body: UpdateMeInput): Promise<UserDto> {
    return this.users.update(user.id, body);
  }

  @HttpCode(204)
  @Post('password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body({ schema: changePasswordSchema }) body: z.infer<typeof changePasswordSchema>,
  ): Promise<void> {
    await this.users.changePassword(user.id, user.sessionId, body.currentPassword, body.newPassword);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser): Promise<SessionDto[]> {
    return this.users.sessions(user.id, user.sessionId);
  }

  @HttpCode(204)
  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id', { schema: idSchema }) id: string): Promise<void> {
    await this.users.revokeSession(user.id, id);
  }
}
