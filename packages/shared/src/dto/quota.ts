import { z } from 'zod';
import { idSchema } from './common';

export const QUOTA_SCOPES = ['user', 'team', 'project'] as const;
export const quotaScopeSchema = z.enum(QUOTA_SCOPES);
export type QuotaScope = z.infer<typeof quotaScopeSchema>;

/** Largest number a JSON number carries exactly; limits and usage stay below it. */
export const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

/** One container's storage as the person sees it. `limit` 0 means "no limit of its own" (projects only). */
export interface QuotaDto {
  scope: QuotaScope;
  used: number;
  limit: number;
}

/** Settings → Storage: usage split by kind. `documents` is the size of the notes' text and structure. */
export interface StorageBreakdownDto extends QuotaDto {
  images: number;
  video: number;
  documents: number;
}

/** Body of the 413 answer when something does not fit. */
export interface QuotaExceededBody {
  statusCode: 413;
  message: 'quota_exceeded';
  code: 'quota_exceeded';
  scope: QuotaScope;
  limit: number;
  used: number;
  requested: number;
}

export interface QuotaLimitsDto {
  /** Bytes. For projects 0 means "limited only by the team". */
  storageBytes: number;
  maxMembers: number;
  maxProjects: number;
  /** Largest single upload in bytes; 0 means the instance-wide MAX_IMAGE_MB / MAX_VIDEO_MB apply. */
  maxFileBytes: number;
}

const limit = z.number().int().min(0).max(MAX_SAFE_BYTES).nullable().optional();

/** What an admin may set. `null` (or leaving a field out) means "use the default". */
export const quotaOverrideSchema = z.object({
  storageBytes: limit,
  maxMembers: z.number().int().min(0).max(1_000_000).nullable().optional(),
  maxProjects: z.number().int().min(0).max(1_000_000).nullable().optional(),
  maxFileBytes: limit,
  note: z.string().trim().max(500).default(''),
});
export type QuotaOverrideInput = z.infer<typeof quotaOverrideSchema>;

export interface QuotaOverrideDto {
  storageBytes: number | null;
  maxMembers: number | null;
  maxProjects: number | null;
  maxFileBytes: number | null;
  note: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AdminQuotaDto {
  scope: QuotaScope;
  id: string;
  used: number;
  defaults: QuotaLimitsDto;
  override: QuotaOverrideDto | null;
  effective: QuotaLimitsDto;
}

export const adminQuotaParamsSchema = z.object({ scope: quotaScopeSchema, id: idSchema });

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(200).optional(),
});

export interface AdminUserDto {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: string;
  used: number;
  limit: number;
  hasOverride: boolean;
}

export interface AdminUsersPage {
  items: AdminUserDto[];
  nextCursor: string | null;
}

export interface AdminStatsDto {
  users: number;
  verifiedUsers: number;
  storageBytes: number;
  teams: number;
}
