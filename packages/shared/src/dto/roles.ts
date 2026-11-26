import { z } from 'zod';
import { ALL_PERMISSIONS, fromString, type PermissionName } from '../permissions/bits';
import type { Reason } from '../permissions/explain';
import { colorSchema, idSchema } from './common';

export const ROLE_NAME_MAX = 40;
/** Teams get at most this many roles (team and project roles together, @everyone excluded) unless `MAX_ROLES_PER_TEAM` says otherwise. */
export const DEFAULT_MAX_ROLES_PER_TEAM = 100;

/** A permission set as a decimal string (BIGINT), with no bit outside the defined ones. */
export const permissionsSchema = z.string().refine((v) => {
  const n = fromString(v);
  return n !== null && (n & ~ALL_PERMISSIONS) === 0n;
}, 'not a valid permission set');

export const roleNameSchema = z.string().trim().min(1).max(ROLE_NAME_MAX);

// ---------------------------------------------------------------- roles

export interface RoleDto {
  id: string;
  teamId: string;
  /** `null` for a team role; the project it belongs to for a project role (it applies there and below). */
  projectId: string | null;
  name: string;
  color: string | null;
  /** Higher is more powerful; @everyone is 0. */
  position: number;
  permissions: string;
  /** Shown as its own group in the member list. */
  hoist: boolean;
  mentionable: boolean;
  isEveryone: boolean;
  memberCount: number;
  createdAt: string;
}

export const createRoleSchema = z.object({
  id: idSchema.optional(),
  name: roleNameSchema,
  color: colorSchema.optional(),
  permissions: permissionsSchema.default('0'),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: roleNameSchema,
    color: colorSchema,
    permissions: permissionsSchema,
    hoist: z.boolean(),
    mentionable: z.boolean(),
  })
  .partial();
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** Every role of the scope (team roles, or one project's roles), most powerful first, @everyone left out. */
export const reorderRolesSchema = z.object({ ids: z.array(idSchema).max(500) });
export type ReorderRolesInput = z.infer<typeof reorderRolesSchema>;

// ---------------------------------------------------------------- overwrites

export const OVERWRITE_TARGETS = ['project', 'channel', 'notebook', 'board'] as const;
export const overwriteTargetSchema = z.enum(OVERWRITE_TARGETS);
export type OverwriteTarget = z.infer<typeof overwriteTargetSchema>;

export interface OverwriteDto {
  id: string;
  targetKind: OverwriteTarget;
  targetId: string;
  subjectKind: 'role' | 'member';
  subjectId: string;
  allow: string;
  deny: string;
}

export const setOverwriteSchema = z
  .object({
    targetKind: overwriteTargetSchema,
    targetId: idSchema,
    subjectKind: z.enum(['role', 'member']),
    subjectId: idSchema,
    allow: permissionsSchema.default('0'),
    deny: permissionsSchema.default('0'),
  })
  .refine((v) => ((fromString(v.allow) ?? 0n) & (fromString(v.deny) ?? 0n)) === 0n, {
    message: 'a permission cannot be both allowed and denied',
    path: ['deny'],
  });
export type SetOverwriteInput = z.infer<typeof setOverwriteSchema>;

export const overwritesQuerySchema = z.object({ kind: overwriteTargetSchema, id: idSchema });
export type OverwritesQuery = z.infer<typeof overwritesQuerySchema>;

// ---------------------------------------------------------------- "view as"

export const previewQuerySchema = z.object({
  subject: z.string().regex(/^(role|member):[0-9a-fA-F-]{36}$/),
  kind: z.enum(['team', 'project']),
  id: idSchema,
});
export type PreviewQuery = z.infer<typeof previewQuerySchema>;

export interface PreviewDecisionDto {
  permission: PermissionName;
  granted: boolean;
  reason: Reason;
}

export interface PreviewDto {
  subject: { kind: 'role' | 'member'; id: string; name: string };
  kind: 'team' | 'project';
  id: string;
  /** Resolved permissions as a decimal string. */
  permissions: string;
  decisions: PreviewDecisionDto[];
  /** Names of the roles and projects the reasons mention, by id, so the page can say "Dev" instead of an id. */
  names: Record<string, string>;
}

// ---------------------------------------------------------------- members

export const updateMemberSchema = z.object({ nickname: z.string().trim().max(80).nullable() });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// ---------------------------------------------------------------- audit log

export interface AuditEntryDto {
  id: string;
  teamId: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
}

export interface AuditPageDto {
  items: AuditEntryDto[];
  /** Pass it back as `cursor` for the next (older) page; `null` at the end. */
  nextCursor: string | null;
}

export const auditQuerySchema = z.object({
  action: z.string().max(60).optional(),
  actor: idSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
