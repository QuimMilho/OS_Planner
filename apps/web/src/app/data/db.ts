import { Injectable, signal } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { JSONContent } from '@tiptap/core';
import type { CategoryDto, ChannelDto, DmDto, MessageDto, NotebookDto, PageMetaDto, ProjectDto, SharedNotebookDto, SyncOp, TeamDto, TeamMemberDto } from '@os-planner/shared';

/** The document of a page, kept apart from its metadata so autosave never re-renders the sidebar. */
export interface PageContentRow {
  id: string;
  content: JSONContent;
  /** The server version this content was based on; sent as `baseVersion` when saving. */
  baseVersion: number;
  /** 1 while there are local edits the server has not accepted yet. */
  dirty: 0 | 1;
  /** Bumped on every local edit, so a save that finishes after a newer edit does not clear `dirty`. */
  rev: number;
  /**
   * Set to `rev` when the server has this edit except for pictures/videos that could not be uploaded yet
   * (storage full). The text is safe; the full document is sent once the files are up.
   */
  heldRev?: number;
}

export interface MediaRow {
  id: string;
  kind: 'image' | 'video';
  mime: string;
  size: number;
  blob: Blob;
  /** 0 until the server has the file; uploads happen before any page content that uses it is pushed. */
  uploaded: 0 | 1;
  /** Set when the server permanently refused the file (too large, unsupported, ...). Not retried. */
  failed?: string | null;
  /** The server has room for nothing more: the file stays queued here and is retried every cycle. */
  blocked?: 'quota' | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** Set for a file used in a notebook that is not the person's own (shared, team, project): it names the space it is stored in. */
  notebookId?: string | null;
}

export interface OutboxRow {
  n?: number;
  op: SyncOp;
}

/** A team member as cached on this device. */
export interface MemberRow extends TeamMemberDto {
  teamId: string;
}

/** A channel as cached on this device (so the sidebar opens offline). */
export interface ChannelRow extends ChannelDto {
  teamId: string;
}

/** A message waiting to be sent, or one the server refused. Sent one after the other, oldest first, each by its own id. */
export interface ChatOutboxRow {
  /** The message id (UUIDv7): a resend of the same row is recognised by the server. */
  id: string;
  channelId: string;
  threadId: string | null;
  content: string;
  replyToId: string | null;
  attachmentIds: string[];
  createdAt: number;
  state: 'queued' | 'failed';
  /** Why it failed (an error code), when it did. */
  error?: string;
  /** A slowmode or rate limit says when to try again (ms since the epoch). */
  retryAt?: number;
}

export class PlannerDb extends Dexie {
  notebooks!: Table<NotebookDto, string>;
  categories!: Table<CategoryDto, string>;
  pages!: Table<PageMetaDto, string>;
  contents!: Table<PageContentRow, string>;
  outbox!: Table<OutboxRow, number>;
  media!: Table<MediaRow, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  teams!: Table<TeamDto, string>;
  projects!: Table<ProjectDto, string>;
  members!: Table<MemberRow, [string, string]>;
  channels!: Table<ChannelRow, string>;
  /** The last messages of each channel that was opened (read-only here: the server owns them). */
  chatMessages!: Table<MessageDto, string>;
  chatOutbox!: Table<ChatOutboxRow, string>;
  /** The person's open direct-message conversations (cached so the list opens offline). */
  dms!: Table<DmDto, string>;
  /** Notebooks other people shared with this person (their content is in the tables above, under the owner's space). */
  shared!: Table<SharedNotebookDto, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      notebooks: 'id',
      categories: 'id, notebookId, parentId',
      pages: 'id, notebookId, categoryId',
      contents: 'id, dirty',
      outbox: '++n',
      media: 'id, uploaded',
      meta: 'key',
    });
    // Teams and projects (cached so the tree and the notebook list open offline) and a space index on the content tables.
    this.version(2).stores({
      notebooks: 'id, spaceId',
      categories: 'id, notebookId, parentId, spaceId',
      pages: 'id, notebookId, categoryId, spaceId',
      teams: 'id, spaceId',
      projects: 'id, teamId, parentId, spaceId',
      members: '[teamId+userId], teamId',
    });
    // Chat: channels, the last messages of the channels that were opened, and messages waiting to be sent.
    this.version(3).stores({
      channels: 'id, teamId, spaceId',
      chatMessages: 'id, channelId, threadId',
      chatOutbox: 'id, channelId, createdAt',
    });
    // Direct messages: the list of conversations.
    this.version(4).stores({ dms: 'id, channelId' });
    // Notebooks shared with the person.
    this.version(5).stores({ shared: 'notebookId, spaceId' });
  }
}

/**
 * One local database per signed-in user, so two accounts on the same device never see each
 * other's notes. Everything in the UI reads from here; the network only feeds it (see Sync).
 */
@Injectable({ providedIn: 'root' })
export class Db {
  /** Null until a user is signed in. */
  readonly current = signal<PlannerDb | null>(null);

  open(userId: string): PlannerDb {
    const existing = this.current();
    if (existing?.name === `os_planner-${userId}`) return existing;
    existing?.close();
    const db = new PlannerDb(`os_planner-${userId}`);
    this.current.set(db);
    return db;
  }

  get db(): PlannerDb {
    const db = this.current();
    if (!db) throw new Error('No user database is open');
    return db;
  }

  /** Releases the database but keeps its data (a session that merely expired must not destroy unsynced work). */
  close(): void {
    const db = this.current();
    if (!db) return;
    this.current.set(null);
    db.close();
  }

  /** Closes and deletes the local copy (on an explicit sign-out, so notes do not linger on a shared computer). */
  async wipe(): Promise<void> {
    const db = this.current();
    if (!db) return;
    this.current.set(null);
    db.close();
    await Dexie.delete(db.name);
  }
}
