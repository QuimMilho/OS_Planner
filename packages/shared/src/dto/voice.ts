import { z } from 'zod';
import { idSchema } from './common';

export const voiceMoveSchema = z.object({ toChannelId: idSchema }).strict();
export type VoiceMoveInput = z.infer<typeof voiceMoveSchema>;
