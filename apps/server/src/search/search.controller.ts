import { Controller, Get, Query } from '@nestjs/common';
import { searchQuerySchema, type SearchResultDto } from '@os-planner/shared';
import type { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { SearchService } from './search.service.js';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(
    @CurrentUser() user: AuthUser,
    @Query({ schema: searchQuerySchema }) q: z.infer<typeof searchQuerySchema>,
  ): Promise<SearchResultDto[]> {
    return this.search.search(user.id, q.q, q.limit, q.notebookId);
  }
}
