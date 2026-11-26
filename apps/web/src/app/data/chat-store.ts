import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subject, debounceTime } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import type {
  ChannelDto,
  ChannelOrderInput,
  CreateChannelInput,
  MessageDto,
  UnreadDto,
  UpdateChannelInput,
} from '@os-planner/shared';
import { AuthStore, toProblem } from '../core/auth-store';
import { RealtimeService } from '../core/realtime';
import { Db, type ChannelRow } from './db';
import { liveSignal } from './live';
import { TeamStore } from './team-store';

/** A connection has room for 100 rooms; leave space for spaces, threads and what features add. */
const MAX_CHANNEL_ROOMS = 60;

export interface UnreadState {
  count: number;
  /** Of those, how many mention the person or answer them. */
  mentions: number;
  lastReadMessageId: string | null;
}

/**
 * Channels of the team the person is looking at, what is unread in them, and the live rooms that keep that current.
 *
 * Channels are read from the local database (so the sidebar opens offline); the server feeds it. While a team is active the
 * app is in the room of every text channel of it: that is how a message in a channel nobody has open shows up as an unread
 * badge at once. Opening a channel (see ChannelPage) is a separate matter: it reads its own messages.
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly http = inject(HttpClient);
  private readonly dbs = inject(Db);
  private readonly rt = inject(RealtimeService);
  private readonly auth = inject(AuthStore);
  private readonly teams = inject(TeamStore);

  private readonly rows = liveSignal(this.dbs, (d) => d.channels.toArray(), [] as ChannelRow[]);
  readonly channelById = computed(() => new Map(this.rows().map((c) => [c.id, c])));
  /** The team whose channels are kept fresh and listened to (set by the shell from the address). */
  readonly activeTeam = signal<string | null>(null);
  /** The channel on screen: messages in it are read as they arrive, so they do not count as unread. */
  readonly openChannel = signal<string | null>(null);
  readonly unread = signal<ReadonlyMap<string, UnreadState>>(new Map());
  /** A message this device sent reached the server. */
  readonly sent = new Subject<MessageDto>();

  private readonly refresh$ = new Subject<void>();

  constructor() {
    this.refresh$.pipe(debounceTime(250)).subscribe(() => {
      const team = this.activeTeam();
      if (team) void this.refreshTeam(team);
    });

    // Be in the room of every text channel of the active team.
    const held = new Map<string, () => void>();
    effect(() => {
      const team = this.activeTeam();
      const want = new Set(
        (team ? this.rows().filter((c) => c.teamId === team && c.kind === 'text') : [])
          .slice(0, MAX_CHANNEL_ROOMS)
          .map((c) => c.id),
      );
      untracked(() => {
        for (const [id, leave] of held) if (!want.has(id)) (leave(), held.delete(id));
        for (const id of want) if (!held.has(id)) held.set(id, this.rt.join('channel', id));
      });
    });

    this.rt.on<MessageDto>('message.created').subscribe((m) => this.onCreated(m));
    this.rt
      .on<{ kind: string; channelId: string | null }>('notification.created')
      .subscribe((n) => this.onNotified(n));
    this.rt.on('notification.read').subscribe(() => this.refresh$.next());
    for (const event of ['channels.changed', 'channel.updated', 'permissions.changed'])
      this.rt.on(event).subscribe(() => this.refresh$.next());
    this.rt.resumed.subscribe(() => this.refresh$.next());
  }

  setActiveTeam(teamId: string | null): void {
    if (this.activeTeam() === teamId) return;
    this.activeTeam.set(teamId);
    if (teamId) void this.refreshTeam(teamId);
  }

  /** What the person may see of the team's chat, and what is unread. A failure (offline) leaves what is cached. */
  async refreshTeam(teamId: string): Promise<boolean> {
    try {
      const [channels, unread] = await Promise.all([
        firstValueFrom(this.http.get<ChannelDto[]>(`/api/teams/${teamId}/channels`)),
        firstValueFrom(this.http.get<UnreadDto[]>(`/api/teams/${teamId}/unread`)),
      ]);
      const db = this.dbs.db;
      await db.transaction('rw', db.channels, async () => {
        await db.channels.where('teamId').equals(teamId).delete();
        await db.channels.bulkPut(channels.map((c) => ({ ...c, teamId })));
      });
      this.unread.update((old) => {
        const next = new Map(old);
        // forget channels that left this team's list (conversations and other teams' channels are not ours to prune)
        const theirs = new Set(this.rows().filter((c) => c.teamId === teamId).map((c) => c.id));
        for (const id of [...next.keys()]) if (theirs.has(id) && !channels.some((c) => c.id === id)) next.delete(id);
        for (const u of unread)
          next.set(u.channelId, { count: u.unread, mentions: u.mentions, lastReadMessageId: u.lastReadMessageId });
        return next;
      });
      return true;
    } catch {
      return false;
    }
  }

  channelsOfTeam(teamId: string): ChannelRow[] {
    return this.rows().filter((c) => c.teamId === teamId);
  }

  unreadOf(channelId: string): number {
    return this.unread().get(channelId)?.count ?? 0;
  }

  mentionsOf(channelId: string): number {
    return this.unread().get(channelId)?.mentions ?? 0;
  }

  /** Unread counts that came from somewhere else (the list of conversations). */
  seedUnread(items: readonly UnreadDto[]): void {
    this.unread.update((old) => {
      const next = new Map(old);
      for (const u of items)
        next.set(u.channelId, { count: u.unread, mentions: u.mentions, lastReadMessageId: u.lastReadMessageId });
      return next;
    });
  }

  /** A mention or reply for me arrived in a channel: it counts unless that channel is the one on screen. */
  private onNotified(n: { kind: string; channelId: string | null }): void {
    if (!n.channelId || !/^(mention_|reply)/.test(n.kind)) return;
    if (this.openChannel() === n.channelId && document.visibilityState === 'visible') return;
    this.unread.update((old) => {
      const next = new Map(old);
      const was = next.get(n.channelId!);
      next.set(n.channelId!, {
        count: was?.count ?? 0,
        mentions: (was?.mentions ?? 0) + 1,
        lastReadMessageId: was?.lastReadMessageId ?? null,
      });
      return next;
    });
  }

  private onCreated(m: MessageDto): void {
    if (m.threadId || m.authorId === this.auth.userId()) return;
    if (this.openChannel() === m.channelId && document.visibilityState === 'visible') return;
    this.unread.update((old) => {
      const next = new Map(old);
      const was = next.get(m.channelId);
      next.set(m.channelId, {
        count: (was?.count ?? 0) + 1,
        mentions: was?.mentions ?? 0,
        lastReadMessageId: was?.lastReadMessageId ?? null,
      });
      return next;
    });
  }

  /** The person has read up to this message: tells the server and clears the badge. */
  async markRead(channelId: string, messageId: string): Promise<void> {
    this.unread.update((old) =>
      new Map(old).set(channelId, { count: 0, mentions: 0, lastReadMessageId: messageId }),
    );
    try {
      await firstValueFrom(this.http.put(`/api/channels/${channelId}/read`, { messageId }));
    } catch {
      /* offline: the badge comes back on the next refresh, which is the honest state */
    }
  }

  // ---------------------------------------------------------------- managing channels (each call is a server round trip)

  async create(
    spaceId: string,
    teamId: string,
    input: Partial<CreateChannelInput> & { name: string },
  ): Promise<ChannelDto> {
    const channel = await this.call(() =>
      firstValueFrom(this.http.post<ChannelDto>(`/api/spaces/${spaceId}/channels`, input)),
    );
    await this.refreshTeam(teamId);
    return channel;
  }

  async update(channel: ChannelRow, patch: UpdateChannelInput): Promise<ChannelDto> {
    const updated = await this.call(() =>
      firstValueFrom(this.http.patch<ChannelDto>(`/api/channels/${channel.id}`, patch)),
    );
    await this.refreshTeam(channel.teamId);
    return updated;
  }

  async remove(channel: ChannelRow): Promise<void> {
    await this.call(() => firstValueFrom(this.http.delete(`/api/channels/${channel.id}`)));
    await this.refreshTeam(channel.teamId);
  }

  async reorder(spaceId: string, teamId: string, input: ChannelOrderInput): Promise<void> {
    await this.call(() =>
      firstValueFrom(this.http.put(`/api/spaces/${spaceId}/channels/order`, input)),
    );
    await this.refreshTeam(teamId);
  }

  /** One channel from the server (a link opened before the list was loaded). Null when it does not exist or may not be seen. */
  async fetch(channelId: string): Promise<ChannelDto | null> {
    try {
      const channel = await firstValueFrom(this.http.get<ChannelDto>(`/api/channels/${channelId}`));
      // Remember it with the others, so the page can read what the person may do in it.
      const teamId = this.teams.placeOfSpace(channel.spaceId)?.team?.id;
      if (teamId) await this.dbs.db.channels.put({ ...channel, teamId });
      return channel;
    } catch (e) {
      const problem = toProblem(e);
      if (problem.offline) throw problem;
      return null;
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toProblem(e);
    }
  }
}
