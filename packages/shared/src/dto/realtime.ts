import { z } from 'zod';
import { idSchema } from './common';
import { JOINABLE_ROOM_KINDS, PRESENCE_MODES } from './realtime-consts';

/** Client → server payloads. */
export const roomJoinSchema = z
  .object({ kind: z.enum(JOINABLE_ROOM_KINDS), id: idSchema })
  .strict();
export type RoomJoinInput = z.infer<typeof roomJoinSchema>;
export const authRefreshSchema = z.object({ token: z.string().min(10).max(4000) }).strict();
export const presenceActivitySchema = z
  .object({
    active: z.boolean().optional(),
    /** The channel (or conversation channel) the page is showing, so a push for it is not needed; null when none. */
    focus: idSchema.nullable().optional(),
  })
  .strict()
  .optional();
export const presenceModeSchema = z.enum(PRESENCE_MODES);
