import { z } from 'zod';
import { idSchema } from './common';

import { IMAGE_MIMES, VIDEO_MIMES } from './mime';

export type MediaKind = 'image' | 'video';

/** Text fields that accompany the file in POST /media (multipart, so everything arrives as strings). */
export const mediaUploadFieldsSchema = z.object({
  /** Chosen by the client so the page content can reference the media before the upload finishes. */
  id: idSchema,
  /** The space the file belongs to (the one of the page that uses it); the person own space when left out. */
  spaceId: idSchema.optional(),
  /** Client-measured hints for videos (the server cannot probe them). Images are measured server-side. */
  width: z.coerce.number().int().min(1).max(16384).optional(),
  height: z.coerce.number().int().min(1).max(16384).optional(),
  durationSec: z.coerce.number().min(0).max(24 * 3600).optional(),
});
export type MediaUploadFields = z.infer<typeof mediaUploadFieldsSchema>;

export interface MediaDto {
  id: string;
  kind: MediaKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt: string;
}
