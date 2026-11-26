import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { Subject, debounceTime, firstValueFrom } from 'rxjs';
import { Permission } from '@os-planner/shared/lite';
import type { BlockDto, DmDto, DmPersonDto } from '@os-planner/shared';
import { toProblem } from '../core/auth-store';
import { RealtimeService } from '../core/realtime';
import { ChatStore } from './chat-store';
import { Db, type ChannelRow } from './db';
import { liveSignal } from './live';

/** What each of the two people may do in a conversation (the server's DM_PERMISSIONS). */
export const DM_PERMISSIONS = String(
  Permission.VIEW_CHANNEL |
    Permission.READ_MESSAGE_HISTORY |
    Permission.SEND_MESSAGES |
    Permission.ATTACH_FILES |
    Permission.ADD_REACTIONS,
);
/** The `teamId` of the cached channel rows that belong to conversations (they are in no team). */
export const DM_TEAM = 'dm';
const MAX_DM_ROOMS = 40;

/** The channel row the chat screen reads, made from a conversation. */
export function channelRowOf(dm: DmDto, name: string): ChannelRow {
  return {
    id: dm.channelId,
    spaceId: '',
    parentId: null,
    kind: 'text',
    name,
    topic: '',
    position: 'a0',
    nsfw: false,
    redactPreviews: false,
    slowmodeSeconds: 0,
    archived: false,
    permissions: DM_PERMISSIONS,
    createdAt: dm.createdAt,
    teamId: DM_TEAM,
  };
}

/**
 * The person's direct-message conversations. They are cached on the device (the list opens offline) and the app is in the
 * room of each, so a new message shows as an unread badge at once; `dm.updated` (sent to the person themselves) says that a
 * conversation was created, reopened, closed or has something new, and the list is then asked for again.
 *
 * The messages themselves are ordinary chat messages of the conversation's channel: the chat screen reads them as it does
 * for a team channel.
 */
@Injectable({ providedIn: 'root' })
export class DmStore {
  private readonly http = inject(HttpClient);
  private readonly dbs = inject(Db);
  private readonly rt = inject(RealtimeService);
  private readonly chat = inject(ChatStore);

  private readonly rows = liveSignal(this.dbs, (d) => d.dms.toArray(), [] as DmDto[]);
  /** Open conversations, the most recent first. */
  readonly list = computed(() =>
    [...this.rows()].sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1)),
  );
  readonly byId = computed(() => new Map(this.rows().map((d) => [d.id, d])));
  readonly byChannel = computed(() => new Map(this.rows().map((d) => [d.channelId, d])));
  /** Unread messages over all conversations (for the badge on the rail). */
  readonly unreadTotal = computed(() =>
    this.rows().reduce((n, d) => n + this.chat.unreadOf(d.channelId), 0),
  );

  private readonly refresh$ = new Subject<void>();

  constructor() {
    this.refresh$.pipe(debounceTime(200)).subscribe(() => void this.refresh());
    this.rt.on('dm.updated').subscribe(() => this.refresh$.next());
    this.rt.on('permissions.changed').subscribe(() => this.refresh$.next());
    this.rt.resumed.subscribe(() => this.refresh$.next());

    // Be in the room of every open conversation: that is how a message in one nobody has open becomes an unread badge.
    const held = new Map<string, () => void>();
    effect(() => {
      const want = new Set(
        this.list()
          .slice(0, MAX_DM_ROOMS)
          .map((d) => d.channelId),
      );
      untracked(() => {
        for (const [id, leave] of held) if (!want.has(id)) (leave(), held.delete(id));
        for (const id of want) if (!held.has(id)) held.set(id, this.rt.join('channel', id));
      });
    });
    // Load the list as soon as there is a database for the signed-in person.
    effect(() => {
      if (this.dbs.current()) untracked(() => void this.refresh());
    });
  }

  displayName(dm: DmDto | null | undefined, deleted: string): string {
    return dm?.peer?.displayName ?? deleted;
  }

  /** Asks the server for the list. A failure (offline) leaves what is cached. */
  async refresh(): Promise<boolean> {
    try {
      const list = await firstValueFrom(this.http.get<DmDto[]>('/api/dms'));
      await this.store(list, true);
      return true;
    } catch {
      return false;
    }
  }

  private async store(list: DmDto[], replace: boolean): Promise<void> {
    const db = this.dbs.db;
    await db.transaction('rw', db.dms, db.channels, async () => {
      if (replace) {
        await db.dms.clear();
        await db.channels.where('teamId').equals(DM_TEAM).delete();
      }
      await db.dms.bulkPut(list);
      await db.channels.bulkPut(list.map((d) => channelRowOf(d, d.peer?.displayName ?? '')));
    });
    this.chat.seedUnread(
      list.map((d) => ({
        channelId: d.channelId,
        unread: d.unread,
        mentions: 0,
        lastReadMessageId: d.lastReadMessageId,
      })),
    );
  }

  /** One conversation from the server (a link opened before the list was loaded). Null when it is not the person's. */
  async fetch(id: string): Promise<DmDto | null> {
    try {
      const dm = await firstValueFrom(this.http.get<DmDto>(`/api/dms/${id}`));
      await this.store([dm], false);
      return dm;
    } catch (e) {
      const problem = toProblem(e);
      if (problem.offline) throw problem;
      return null;
    }
  }

  /** The conversation with that person, made if it does not exist. A refusal is the same for every reason. */
  async start(userId: string): Promise<DmDto> {
    try {
      const dm = await firstValueFrom(this.http.post<DmDto>('/api/dms', { userId }));
      await this.store([dm], false);
      return dm;
    } catch (e) {
      throw toProblem(e);
    }
  }

  async setClosed(dm: DmDto, closed: boolean): Promise<void> {
    try {
      const next = await firstValueFrom(
        this.http.post<DmDto>(`/api/dms/${dm.id}/${closed ? 'close' : 'open'}`, {}),
      );
      if (closed) await this.dbs.db.dms.delete(dm.id);
      else await this.store([next], false);
    } catch (e) {
      throw toProblem(e);
    }
  }

  people(q: string): Promise<DmPersonDto[]> {
    return firstValueFrom(
      this.http.get<DmPersonDto[]>('/api/dms/people', { params: q ? { q } : {} }),
    );
  }

  // ---------------------------------------------------------------- blocks

  blocks(): Promise<BlockDto[]> {
    return firstValueFrom(this.http.get<BlockDto[]>('/api/blocks'));
  }

  async block(userId: string, on: boolean): Promise<void> {
    try {
      await firstValueFrom(
        on ? this.http.put(`/api/blocks/${userId}`, {}) : this.http.delete(`/api/blocks/${userId}`),
      );
      await this.refresh();
    } catch (e) {
      throw toProblem(e);
    }
  }
}
