import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  addProjectMemberSchema,
  createProjectSchema,
  idSchema,
  moveProjectSchema,
  updateMemberSchema,
  updateProjectSchema,
  updateTeamSchema,
  type UpdateMemberInput,
  type AddProjectMemberInput,
  type CreateProjectInput,
  type MoveProjectInput,
  type ProjectDto,
  type ProjectMemberDto,
  type TeamDto,
  type TeamMeDto,
  type TeamMemberDto,
  type UpdateProjectInput,
  type UpdateTeamInput,
} from '@os-planner/shared';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { ProjectsService } from './projects.service.js';
import { TeamsService } from './teams.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });
const UserParam = () => Param('userId', { schema: idSchema });

/** Everything about a team that its members may ask for. A team the person is not in answers 404 everywhere. */
@Controller('teams')
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly projects: ProjectsService,
  ) {}

  @Authz({ scope: 'self' })
  @Get()
  mine(@CurrentUser() u: AuthUser): Promise<TeamDto[]> {
    return this.teams.list(u.id);
  }

  @Authz({ scope: 'team' })
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Id() id: string): Promise<TeamDto> {
    return this.teams.get(u.id, id);
  }

  @Authz({ scope: 'team', needs: ['MANAGE_TEAM'] })
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateTeamSchema }) body: UpdateTeamInput,
  ): Promise<TeamDto> {
    return this.teams.update(u.id, id, body);
  }

  @Authz({ scope: 'team' })
  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Id() id: string): Promise<TeamMemberDto[]> {
    return this.teams.members(u.id, id);
  }

  /** Leave the team. (Declared before `:userId`, which only matches ids.) */
  @HttpCode(204)
  @Authz({ scope: 'team', note: 'the owner must hand the team over first' })
  @Delete(':id/members/me')
  async leave(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.teams.removeMember(u.id, id, u.id);
  }

  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'], note: 'only people ranked below the caller' })
  @Delete(':id/members/:userId')
  async removeMember(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
  ): Promise<void> {
    await this.teams.removeMember(u.id, id, userId);
  }

  /** The member's nickname in this team: their own, or anyone's with MANAGE_MEMBERS. */
  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'], note: 'anybody may set their own nickname' })
  @Patch(':id/members/:userId')
  async nickname(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
    @Body({ schema: updateMemberSchema }) body: UpdateMemberInput,
  ): Promise<void> {
    await this.teams.setNickname(u.id, id, userId, body.nickname);
  }

  @Authz({ scope: 'team' })
  @Get(':id/me')
  me(@CurrentUser() u: AuthUser, @Id() id: string): Promise<TeamMeDto> {
    return this.teams.me(u.id, id);
  }

  @Authz({ scope: 'team' })
  @Get(':id/projects')
  projectTree(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ProjectDto[]> {
    return this.projects.list(u.id, id);
  }

  @Authz({ scope: 'team', needs: ['MANAGE_PROJECTS'] })
  @Post(':id/projects')
  createProject(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createProjectSchema }) body: CreateProjectInput,
  ): Promise<ProjectDto> {
    return this.projects.create(u.id, id, body);
  }
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Authz({ scope: 'project' })
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ProjectDto> {
    return this.projects.get(u.id, id);
  }

  @Authz({ scope: 'project', needs: ['MANAGE_PROJECTS'] })
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateProjectSchema }) body: UpdateProjectInput,
  ): Promise<ProjectDto> {
    return this.projects.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'project', needs: ['MANAGE_PROJECTS'] })
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.projects.remove(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'project', needs: ['MANAGE_PROJECTS'], note: 'also in the new parent' })
  @Post(':id/move')
  move(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: moveProjectSchema }) body: MoveProjectInput,
  ): Promise<ProjectDto> {
    return this.projects.move(u.id, id, body);
  }

  @Authz({ scope: 'project' })
  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ProjectMemberDto[]> {
    return this.projects.members(u.id, id);
  }

  @Authz({ scope: 'project', needs: ['MANAGE_PROJECTS'], note: 'a sub-project member must be in the parent' })
  @Post(':id/members')
  addMember(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: addProjectMemberSchema }) body: AddProjectMemberInput,
  ): Promise<ProjectMemberDto[]> {
    return this.projects.addMember(u.id, id, body.userId);
  }

  @HttpCode(204)
  @Authz({ scope: 'project', needs: ['MANAGE_PROJECTS'] })
  @Delete(':id/members/:userId')
  async removeMember(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
  ): Promise<void> {
    await this.projects.removeMember(u.id, id, userId);
  }
}
