import { Inject, Injectable } from '@nestjs/common';
import type { QuotaLimitsDto, QuotaScope } from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';

const MB = 1024 * 1024;

/**
 * Where default limits come from. The instance ships with `EnvQuotaPolicy` (settings in the
 * environment); plans or billing replace this one provider and nothing else changes: callers only
 * ever ask `QuotaService`, which layers an admin's per-user/team/project override on top.
 */
export abstract class QuotaPolicy {
  abstract defaults(scope: QuotaScope): QuotaLimitsDto;
}

@Injectable()
export class EnvQuotaPolicy extends QuotaPolicy {
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  defaults(scope: QuotaScope): QuotaLimitsDto {
    switch (scope) {
      case 'user':
        // A person has no members or projects of their own to limit.
        return {
          storageBytes: Math.floor(this.env.USER_QUOTA_MB * MB),
          maxMembers: 0,
          maxProjects: 0,
          maxFileBytes: 0,
        };
      case 'team':
        return {
          storageBytes: Math.floor(this.env.TEAM_QUOTA_MB * MB),
          maxMembers: this.env.MAX_MEMBERS_PER_TEAM,
          maxProjects: this.env.MAX_PROJECTS_PER_TEAM,
          maxFileBytes: 0,
        };
      case 'project':
        return {
          storageBytes: Math.floor(this.env.PROJECT_QUOTA_MB * MB),
          maxMembers: 0,
          maxProjects: 0,
          maxFileBytes: 0,
        };
    }
  }
}
