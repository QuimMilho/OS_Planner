/**
 * The realtime connection (Socket.IO, path /api/realtime). One socket per tab; everything a feature wants to push
 * to a person goes through a room the server decided they may be in.
 */
export const REALTIME_PATH = '/api/realtime';

/** Rooms a client may ask to join. `user:<id>` and `team:<id>` are joined by the server itself. */
export const JOINABLE_ROOM_KINDS = ['space', 'channel', 'thread'] as const;
export type JoinableRoomKind = (typeof JOINABLE_ROOM_KINDS)[number];
export type RoomKind = JoinableRoomKind | 'user' | 'team';

export const roomName = (kind: RoomKind, id: string): string => `${kind}:${id}`;

export const CLIENT_EVENTS = [
  'room:join',
  'room:leave',
  'auth:refresh',
  'presence:activity',
] as const;

/** An acknowledgement: `ok:false` never says why (a room the person may not see looks like one that does not exist). */
export interface Ack {
  ok: boolean;
}

/** Why the server dropped a connection (sent as the `connect_error` message or the `disconnect` reason). */
export const REALTIME_ERRORS = [
  'unauthorized',
  'origin_not_allowed',
  'too_many_connections',
  'token_expired',
  'session_revoked',
] as const;

export const PRESENCE_STATUSES = ['online', 'idle', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
export const PRESENCE_MODES = ['auto', 'invisible'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

/** Idle after this long without a `presence:activity` ping. */
export const IDLE_AFTER_MS = 5 * 60_000;
/** At most one presence update per person per this long. */
export const PRESENCE_THROTTLE_MS = 5_000;
/** Limits per connection. */
export const REALTIME_LIMITS = {
  socketsPerUser: 5,
  roomsPerSocket: 100,
  payloadBytes: 1_000_000,
  eventsPerSecond: 30,
} as const;

/** Server → client: `presence.update`. */
export interface PresenceUpdate {
  userId: string;
  status: PresenceStatus;
  /** ISO time of the last activity, null while online. */
  lastSeen: string | null;
}

/** Server → client: `permissions.changed`. `teamId` is set when one team's roles, overwrites or membership changed. */
export interface PermissionsChanged {
  teamId?: string;
}

/** Server → client: `space.changed`: something in the space changed; pull sync now instead of waiting for the timer. */
export interface SpaceChanged {
  spaceId: string;
  seq: string;
}

/** Server → client: `session.revoked` (the connection closes right after). */
export interface SessionRevoked {
  reason: 'signed_out' | 'password_changed' | 'revoked';
}

/** The names of the events the server sends. Features add their own in their phase. */
export const SERVER_EVENTS = {
  permissionsChanged: 'permissions.changed',
  presenceUpdate: 'presence.update',
  spaceChanged: 'space.changed',
  sessionRevoked: 'session.revoked',
  /** Room user:<id>: a direct-message conversation changed (new, reopened, closed, new message). */
  dmUpdated: 'dm.updated',
} as const;

/** `GET /api/teams/:id/presence`: everyone of the team who is not offline (and not invisible). */
export interface TeamPresenceDto {
  teamId: string;
  online: PresenceUpdate[];
}

/** `GET /api/admin/realtime`. */
export interface RealtimeStatsDto {
  /** Connections on the instance that answered. */
  sockets: number;
  rooms: number;
  users: number;
  redis: boolean;
  /** Events a client sent that the server does not know, or that failed validation or the rate limit. */
  dropped: { unknown: number; invalid: number; rateLimited: number };
  /** Connections refused at the handshake, by reason. */
  refused: Record<string, number>;
}
