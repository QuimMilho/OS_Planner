import { z } from 'zod';
import { emailSchema } from './auth';
import { colorSchema, iconSchema, idSchema, positionSchema } from './common';
import type { QuotaLimitsDto } from './quota';

export const TEAM_NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
/** Sub-projects nest at most this deep (a root project is depth 1): keeps the materialised path short. */
export const MAX_PROJECT_DEPTH = 16;

export const teamNameSchema = z.string().trim().min(1).max(TEAM_NAME_MAX);
export const descriptionSchema = z.string().trim().max(DESCRIPTION_MAX);
export const joinPolicySchema = z.enum(['open', 'request']);
export type JoinPolicy = z.infer<typeof joinPolicySchema>;

export const TAG_MAX = 24;
export const MAX_TAGS = 8;
export const BLURB_MAX = 200;

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(TAG_MAX)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u);
export const listingTagsSchema = z
  .array(tagSchema)
  .max(MAX_TAGS)
  .transform((tags) => [...new Set(tags)]);
export const listingBlurbSchema = z.string().trim().max(BLURB_MAX);

// ---------------------------------------------------------------- teams

export interface TeamDto {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  description: string;
  isPublic: boolean;
  joinPolicy: JoinPolicy;
  /** The line shown on the directory card (public teams). */
  listingBlurb: string;
  listingTags: string[];
  /** Whether members may message each other directly because of this team. */
  allowMemberDMs: boolean;
  /** Whether people with SHARE_NOTEBOOKS may make public read links to the team notebooks. */
  allowPublicLinks: boolean;
  /** The team own space (its notebooks and sync cursor). */
  spaceId: string;
  ownerId: string | null;
  /** Whether the person asking is the owner. */
  isOwner: boolean;
  memberCount: number;
  createdAt: string;
}

export const updateTeamSchema = z
  .object({
    name: teamNameSchema,
    description: descriptionSchema,
    icon: iconSchema,
    color: colorSchema,
    isPublic: z.boolean(),
    joinPolicy: joinPolicySchema,
    listingBlurb: listingBlurbSchema,
    listingTags: listingTagsSchema,
    allowMemberDMs: z.boolean(),
    allowPublicLinks: z.boolean(),
  })
  .partial();
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export interface TeamMemberDto {
  userId: string;
  displayName: string;
  nickname: string | null;
  isOwner: boolean;
  /** Ids of the team roles the member holds (@everyone is implicit and not listed). */
  roleIds: string[];
  joinedAt: string;
}

/** What the person may do in a team, for the web UI to show or hide controls. The server stays authoritative. */
export interface TeamMeDto {
  teamId: string;
  isOwner: boolean;
  /** Team-level permissions as a decimal string (BIGINT). */
  permissions: string;
  /** Resolved permissions inside every project the person can see, by project id. */
  projects: Record<string, string>;
  /** Join requests waiting for a decision; counted only for people who may decide (`MANAGE_MEMBERS`), else 0. */
  pendingRequests: number;
}

// ---------------------------------------------------------------- admin: teams

export const createTeamSchema = z.object({
  name: teamNameSchema,
  ownerEmail: emailSchema,
  isPublic: z.boolean().default(false),
  joinPolicy: joinPolicySchema.default('request'),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export interface AdminTeamDto {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  joinPolicy: JoinPolicy;
  owner: { id: string; email: string; displayName: string } | null;
  /** Set while the named owner has no verified account yet. */
  pendingOwnerEmail: string | null;
  memberCount: number;
  projectCount: number;
  used: number;
  limits: QuotaLimitsDto;
  createdAt: string;
}

// ---------------------------------------------------------------- projects

export interface ProjectDto {
  id: string;
  teamId: string;
  parentId: string | null;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  position: string;
  spaceId: string;
  archivedAt: string | null;
  createdAt: string;
  /** Whether the person asking is a member (as opposed to seeing it because they manage projects). */
  isMember: boolean;
}

export const createProjectSchema = z.object({
  id: idSchema.optional(),
  name: teamNameSchema,
  parentId: idSchema.nullable().optional(),
  description: descriptionSchema.optional(),
  icon: iconSchema.optional(),
  color: colorSchema.optional(),
  position: positionSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: teamNameSchema,
    description: descriptionSchema,
    icon: iconSchema,
    color: colorSchema,
    position: positionSchema,
    archived: z.boolean(),
  })
  .partial();
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const moveProjectSchema = z.object({
  parentId: idSchema.nullable(),
  position: positionSchema.optional(),
});
export type MoveProjectInput = z.infer<typeof moveProjectSchema>;

export const addProjectMemberSchema = z.object({ userId: idSchema });
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;

export interface ProjectMemberDto {
  userId: string;
  displayName: string;
  /** Ids of the roles of this project the member holds (team roles are on the team member). */
  roleIds: string[];
  joinedAt: string;
}
