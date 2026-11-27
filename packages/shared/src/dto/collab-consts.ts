/**
 * Real-time co-editing (Hocuspocus/Yjs on the API's own HTTP server, path /api/collab). Constants only: the Yjs helpers
 * live in `@os-planner/shared/collab`, so code that does not edit pages never loads Yjs.
 */
export const COLLAB_PATH = '/api/collab';

/** The Yjs XML fragment that holds a page's document (mapped to the TipTap schema). */
export const COLLAB_FIELD = 'content';

export const COLLAB_LIMITS = {
  /** Open co-editing connections one person may hold on the same page (tabs and devices). */
  connectionsPerUserPerPage: 6,
  /** Open co-editing connections on one page, everybody together. */
  connectionsPerPage: 60,
  /** Updates one connection may send per second, on average (a burst of twice this is tolerated). */
  updatesPerSecond: 60,
  /** One incoming message may not be larger than this (an image never travels through here: only its id does). */
  messageBytes: 2 * 1024 * 1024,
  /** Characters of a person's name shown on a caret. */
  nameMax: 60,
} as const;

/** Why the server did not store a version of the document (sent to every connection of the page as a stateless message). */
export const COLLAB_REFUSALS = ['too_large', 'quota', 'invalid'] as const;
export type CollabRefusal = (typeof COLLAB_REFUSALS)[number];

/** Stateless messages (JSON text) exchanged next to the Yjs updates. */
export type CollabClientMessage = { t: 'flush' };
export type CollabServerMessage =
  { t: 'stored'; version: number } | { t: 'refused'; reason: CollabRefusal };

/** What a person shows to the others on a page: nothing but a name and a colour (and the cursor y-prosemirror adds). */
export interface CollabUser {
  name: string;
  color: string;
}

/**
 * A stable colour for a person: the same hue everywhere, dark enough for white text on top of it and visible as a thin line on
 * light and dark pages. A six-digit hex colour, because that is the only format the cursor code of the editor accepts.
 */
export function collabColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const s = 0.62;
  const l = 0.38;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const k = (n + hue / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
export const COLLAB_COLOR = /^#[0-9a-f]{6}$/;

/** What the administrator sees of co-editing: this instance's open pages, and how much the live documents and snapshots take. */
export interface CollabStatsDto {
  documents: number;
  connections: number;
  redis: boolean;
  /** Pages written from their live document since the server started, and refusals by reason. */
  stores: number;
  refused: Record<CollabRefusal, number>;
  /** Pages that have a live document, and the bytes of all of them (not charged to anybody's quota). */
  yDocPages: number;
  yDocBytes: number;
  snapshots: number;
  snapshotBytes: number;
}

export const SNAPSHOT_REASONS = ['session_end', 'hourly', 'pre_merge', 'manual'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/** One saved version of a page's document (the list; the document itself is fetched on demand). */
export interface PageSnapshotDto {
  id: string;
  pageId: string;
  reason: SnapshotReason;
  createdAt: string;
  byUserId: string | null;
  byName: string | null;
}
