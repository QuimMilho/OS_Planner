import { z } from 'zod';
import { emailSchema, tokenSchema } from './auth';
import { idSchema } from './common';
import { tagSchema, type JoinPolicy } from './teams';

// ---------------------------------------------------------------- invites

/** How long an invite lives when its creator does not say: links are shorter-lived than invitations to one person. */
export const LINK_INVITE_DAYS = 7;
export const EMAIL_INVITE_DAYS = 14;
export const MAX_INVITE_DAYS = 90;
export const MAX_INVITE_USES = 10_000;

export const INVITE_STATUSES = ['active', 'used', 'expired', 'revoked'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** Either an invitation to one address (`email`) or a link (`link: true`); not both, not neither. */
export const createInviteSchema = z
  .object({
    email: emailSchema.optional(),
    link: z.literal(true).optional(),
    /** Team roles (or roles of `projectId`) the person gets when they join. */
    roleIds: z.array(idSchema).max(25).default([]),
    /** Also put the person in this project. */
    projectId: idSchema.optional(),
    /** Links only: how many people may use it. Leave out for no limit. */
    maxUses: z.number().int().min(1).max(MAX_INVITE_USES).optional(),
    expiresInDays: z.number().int().min(1).max(MAX_INVITE_DAYS).optional(),
  })
  .refine((v) => (v.email !== undefined) !== (v.link === true), { message: 'email_or_link' })
  .refine((v) => v.email === undefined || v.maxUses === undefined, {
    message: 'max_uses_links_only',
  });
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export interface InviteDto {
  id: string;
  teamId: string;
  kind: 'email' | 'link';
  email: string | null;
  projectId: string | null;
  roleIds: string[];
  maxUses: number | null;
  uses: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { id: string; displayName: string } | null;
  acceptedBy: { id: string; displayName: string } | null;
  acceptedAt: string | null;
  status: InviteStatus;
}

/** Answer to creating an invite: the token appears here once and is never shown again (a link invite is a URL). */
export interface CreatedInviteDto extends InviteDto {
  /** Only for links. The address to give out: `<APP_URL>/invite/<token>`. */
  url: string | null;
}

export const inviteTokenQuerySchema = z.object({ token: tokenSchema });
export const acceptInviteSchema = z.object({ token: tokenSchema });
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/** What a stranger holding an invite may learn about the team. Never the members. */
export interface InvitePreviewDto {
  teamName: string;
  icon: string | null;
  color: string | null;
  memberCount: number;
}

export interface AcceptedInviteDto {
  teamId: string;
  /** False when the person was already a member (nothing was used up). */
  joined: boolean;
}

// ---------------------------------------------------------------- directory

export type MyJoinStatus = 'none' | 'member' | 'requested';

export interface DirectoryTeamDto {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  description: string;
  blurb: string;
  tags: string[];
  joinPolicy: JoinPolicy;
  memberCount: number;
  /** The caller's own standing: already in, waiting for a decision, or neither. */
  mine: MyJoinStatus;
}

export interface DirectoryPageDto {
  items: DirectoryTeamDto[];
  nextCursor: string | null;
}

export const directoryQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: tagSchema.optional(),
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;

// ---------------------------------------------------------------- joining

export const joinTeamSchema = z.object({ message: z.string().trim().max(500).default('') });
export type JoinTeamInput = z.infer<typeof joinTeamSchema>;

export type JoinOutcome = 'joined' | 'requested';
export interface JoinResultDto {
  status: JoinOutcome;
  teamId: string;
}

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'withdrawn'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export interface JoinRequestDto {
  id: string;
  teamId: string;
  userId: string;
  displayName: string;
  message: string;
  status: JoinRequestStatus;
  createdAt: string;
  decidedAt: string | null;
}

export const joinRequestParamsSchema = z.object({ id: idSchema, rid: idSchema });

// ---------------------------------------------------------------- bans and ownership

export const banSchema = z.object({ reason: z.string().trim().max(500).default('') });
export type BanInput = z.infer<typeof banSchema>;

export interface BanDto {
  userId: string;
  displayName: string;
  reason: string;
  createdAt: string;
}

export const transferOwnershipSchema = z.object({
  userId: idSchema,
  password: z.string().min(1).max(128),
});
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
