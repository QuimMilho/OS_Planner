// What the website needs of voice and video channels on its first load (no schemas: those are in ./voice).

export const VOICE_LIMITS = {
  /** Largest `userLimit` a channel can be given. */
  userLimitMax: 100,
  /** A LiveKit access token lives this long (it is only needed to join; a reconnect asks for a new one). */
  tokenSeconds: 600,
  /** Participant attribute set while a moderator keeps the person's microphone off. */
  attributeModMuted: 'modMuted',
} as const;

/** Audio quality of a voice channel: the bit rate of the microphone track, in bits per second. */
export const VOICE_QUALITY = ['low', 'normal', 'high'] as const;
export type VoiceQuality = (typeof VOICE_QUALITY)[number];
export const VOICE_BITRATE: Record<VoiceQuality, number> = {
  low: 24_000,
  normal: 48_000,
  high: 96_000,
};

export const VOICE_EVENTS = {
  /** Room `channel:<id>`: who is in the voice channel now (the whole list). */
  participants: 'voice.participants',
  /** Room `user:<id>`: a moderator did something to this person (mute, unmute, move, disconnect). */
  moderated: 'voice.moderated',
} as const;

/** What the instance can do; the website hides what is off. `GET /api/features`. */
export interface FeaturesDto {
  voice: boolean;
  push: boolean;
  collab: boolean;
}

export interface VoiceParticipantDto {
  userId: string;
  /** The team nickname, else the display name. */
  name: string;
  color: string;
  joinedAt: string;
  mutedByModerator: boolean;
}

export interface VoiceChannelStateDto {
  channelId: string;
  participants: VoiceParticipantDto[];
}

/** Event `voice.moderated` (room `user:<id>`). */
export interface VoiceModeratedEvent {
  action: 'mute' | 'unmute' | 'move' | 'disconnect';
  channelId: string;
  /** Where the person was moved (action `move`). */
  toChannelId: string | null;
  byUserId: string;
  byName: string;
}

export interface VoiceTokenDto {
  /** The public address of the media server (wss://…). */
  url: string;
  token: string;
  expiresAt: string;
  /** What the token lets the person publish, for the UI (the server-issued token is what really decides). */
  canSpeak: boolean;
  canVideo: boolean;
  canShare: boolean;
  /** Audio bit rate of the channel, bits per second. */
  bitrate: number;
  mutedByModerator: boolean;
}
