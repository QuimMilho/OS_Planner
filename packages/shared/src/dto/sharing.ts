import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';
import { emailSchema } from './auth';
import { idSchema } from './common';
import type { CategoryDto, NotebookDto, PageMetaDto } from './entities';

/** What a person may do with a notebook that is shared with them, or reachable through a link. */
export const SHARE_ACCESS = ['read', 'edit'] as const;
export const shareAccessSchema = z.enum(SHARE_ACCESS);
export type ShareAccess = z.infer<typeof shareAccessSchema>;

export const LINK_MAX_DAYS = 365;
export const LINK_PASSWORD_MIN = 4;
export const LINK_PASSWORD_MAX = 200;
/** Wrong password tries per link and address before the link answers 429 for a while. */
export const LINK_PASSWORD_TRIES = 5;

// ---------------------------------------------------------------- shared with people

export interface ShareDto {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  access: ShareAccess;
  /** Came from using an edit link (it ends when that link is revoked). */
  viaLink: boolean;
  createdAt: string;
}

/** An address that has no verified account yet: the share starts when somebody verifies it. */
export interface PendingShareDto {
  id: string;
  email: string;
  access: ShareAccess;
  createdAt: string;
}

export interface NotebookSharesDto {
  shares: ShareDto[];
  pending: PendingShareDto[];
}

export const putShareSchema = z
  .object({ userId: idSchema.optional(), email: emailSchema.optional(), access: shareAccessSchema })
  .refine((v) => (v.userId === undefined) !== (v.email === undefined), {
    message: 'give userId or email',
  });
export type PutShareInput = z.infer<typeof putShareSchema>;

/** What `PUT /notebooks/:id/shares` answers for an email: the same whether or not the address has an account. */
export interface PutShareResult {
  ok: true;
  /** Set when a person (not an email) was named: the share that now exists. */
  share?: ShareDto;
}

/** A notebook somebody shared with the person (the notebook itself arrives through sync as `shared:<id>`). */
export interface SharedNotebookDto {
  notebookId: string;
  /** The space that owns the notebook (not the person's). */
  spaceId: string;
  name: string;
  icon: string | null;
  color: string | null;
  access: ShareAccess;
  ownerName: string;
  viaLink: boolean;
  sharedAt: string;
}

// ---------------------------------------------------------------- links

export interface ShareLinkDto {
  id: string;
  notebookId: string;
  access: ShareAccess;
  hasPassword: boolean;
  showAuthors: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The address to hand out. Only the answer to creating a link carries it: the server keeps just a hash. */
  url?: string;
  /** Same, the bare token. */
  token?: string;
}

const passwordSchema = z.string().min(LINK_PASSWORD_MIN).max(LINK_PASSWORD_MAX);

export const createLinkSchema = z.object({
  access: shareAccessSchema,
  expiresInDays: z.number().int().min(1).max(LINK_MAX_DAYS).optional(),
  password: passwordSchema.optional(),
  showAuthors: z.boolean().optional(),
});
export type CreateLinkInput = z.infer<typeof createLinkSchema>;

/** `null` clears the expiry or the password. */
export const updateLinkSchema = z
  .object({
    expiresInDays: z.number().int().min(1).max(LINK_MAX_DAYS).nullable(),
    password: passwordSchema.nullable(),
    showAuthors: z.boolean(),
  })
  .partial();
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;

export const linkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);

export const resolveLinkSchema = z.object({
  token: linkTokenSchema,
  password: z.string().max(LINK_PASSWORD_MAX).optional(),
});
export type ResolveLinkInput = z.infer<typeof resolveLinkSchema>;

export const joinLinkSchema = z.object({
  token: linkTokenSchema,
  password: z.string().max(LINK_PASSWORD_MAX).optional(),
});
export type JoinLinkInput = z.infer<typeof joinLinkSchema>;

// ---------------------------------------------------------------- the public view (no ids of people, no spaces)

export interface PublicCategoryDto {
  id: string;
  parentId: string | null;
  name: string;
  position: string;
}
export interface PublicPageDto {
  id: string;
  categoryId: string;
  title: string;
  position: string;
  updatedAt: string;
}
export interface PublicPageContentDto extends PublicPageDto {
  content: JSONContent;
}

export interface LinkViewDto {
  notebook: { id: string; name: string; icon: string | null; color: string | null };
  /** What the link allows. Anonymous visitors only ever read; editing needs a login (see `joinLink`). */
  access: ShareAccess;
  /** The owner's display name, only when the link was made with `showAuthors`. */
  ownerName: string | null;
  categories: PublicCategoryDto[];
  pages: PublicPageDto[];
  /** Proof that this visitor passed the link's checks (password); sent with every later request for it. Short-lived. */
  session: string;
}

export interface PublicSearchHitDto {
  pageId: string;
  title: string;
  categoryName: string;
  snippet: string;
}

export const linkSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  s: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------- moving

export const moveNotebookSchema = z.object({ spaceId: idSchema });
export type MoveNotebookInput = z.infer<typeof moveNotebookSchema>;

// ---------------------------------------------------------------- sync: what the server adds for shared notebooks

export { isSharedCursorKey, notebookOfSharedKey, sharedCursorKey } from './shared-keys';

/** A tree as the reader of a shared notebook needs it, for tests and the e2e. */
export interface SharedTreeDto {
  notebook: NotebookDto;
  categories: CategoryDto[];
  pages: PageMetaDto[];
}
