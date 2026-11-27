import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, computed, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  CALENDAR_EVENTS,
  hasPermission,
  Permission,
  permissionsFromString,
} from '@os-planner/shared/lite';
import type {
  AddAttendeesInput,
  AttendeeInput,
  CalendarPeopleDto,
  CalendarPermissionsDto,
  CalendarSettingsDto,
  CreateEventInput,
  EditScope,
  EventDetailDto,
  EventDto,
  EventExceptionDto,
  EventOverrideDto,
  RsvpAnswer,
  RsvpCountsDto,
  UpdateEventInput,
} from '@os-planner/shared';
import { AuthStore, toProblem } from '../core/auth-store';
import { uuidv7 } from '../core/ids';
import { RealtimeService } from '../core/realtime';
import { Db } from './db';
import { liveSignal } from './live';
import { Outbox } from './outbox';

const PERMS_KEY = 'calendarPerms';
const SETTINGS_KEY = 'calendarSettings';

export const DEFAULT_SETTINGS: CalendarSettingsDto = {
  defaultTz: null,
  weekStart: 1,
  defaultReminders: [10],
  hiddenSpaces: [],
  openInvites: false,
  emailReminders: false,
};

/** Why the store refused something locally (the server says the same when asked). */
export class CalendarError extends Error {
  constructor(readonly code: 'read_only' | 'not_found' | 'online_only' | 'invalid') {
    super(code);
  }
}

const key = (iso: string): string => new Date(iso).toISOString();

/**
 * Events on this device, what the person may do with them, and the changes they make.
 *
 * The rows come from sync (and are re-read when the server announces a change). Making, changing, cancelling and answering events is
 * applied here at once and queued for the server like every offline change; the server decides when it arrives. What needs the server
 * to answer (who is invited, the rest of a series, the list of people) is online-only. Expanding repeating events into what the screens
 * show is done by the calendar screens themselves (they hold the recurrence code), not here.
 */
@Injectable({ providedIn: 'root' })
export class CalendarStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);
  private readonly outbox = inject(Outbox);
  private readonly auth = inject(AuthStore);
  private readonly rt = inject(RealtimeService);
  private readonly injector = inject(Injector);

  readonly events = liveSignal(this.dbs, (d) => d.events.toArray(), [] as EventDto[]);
  readonly settings = liveSignal(
    this.dbs,
    async (d) => ({
      ...DEFAULT_SETTINGS,
      ...(((await d.meta.get(SETTINGS_KEY))?.value as Partial<CalendarSettingsDto> | undefined) ??
        {}),
    }),
    DEFAULT_SETTINGS,
  );
  private readonly perms = liveSignal(
    this.dbs,
    async (d) => ((await d.meta.get(PERMS_KEY))?.value ?? { spaces: {} }) as CalendarPermissionsDto,
    { spaces: {} } as CalendarPermissionsDto,
  );

  /** Every space whose calendar the person sees. */
  readonly spaceIds = computed(() => Object.keys(this.perms().spaces));
  readonly liveEvents = computed(() => this.events().filter((e) => !e.deletedAt));
  readonly eventById = computed(() => new Map(this.events().map((e) => [e.id, e])));
  readonly userId = computed(() => this.auth.userId() ?? '');
  /** The person's own space: events there are theirs alone. */
  readonly personalSpaceId = computed(() => this.auth.user()?.personalSpaceId ?? '');

  /** Events that wait for the person's answer and have not ended: the badge on the calendar link. */
  readonly pendingInvites = computed(() => {
    const now = Date.now();
    return this.liveEvents().filter(
      (e) =>
        e.me?.status === 'invited' &&
        e.ownerId !== this.userId() &&
        (e.rrule ? true : new Date(e.endAt).getTime() > now),
    ).length;
  });

  constructor() {
    // Something changed for somebody on an event: pull now (the room of the space says the same, but the person may not be in it).
    for (const name of [
      CALENDAR_EVENTS.eventCreated,
      CALENDAR_EVENTS.eventUpdated,
      CALENDAR_EVENTS.eventCancelled,
      CALENDAR_EVENTS.eventInvited,
      CALENDAR_EVENTS.rsvpChanged,
    ])
      this.rt.on(name).subscribe(() => this.sync());
  }

  private sync(): void {
    // Sync injects this store, so it is asked for here and not at construction.
    void import('./sync').then(({ Sync }) => void this.injector.get(Sync).run());
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toProblem(e);
    }
  }

  // ------------------------------------------------------------------ what the person may do

  isPersonalSpace(spaceId: string): boolean {
    return spaceId === this.personalSpaceId();
  }

  /** Whether the person may do `permission` in a space's calendar. Their own space: everything. Unknown means no. */
  can(spaceId: string, permission: bigint): boolean {
    if (spaceId === this.personalSpaceId()) return true;
    const raw = this.perms().spaces[spaceId];
    const set = raw === undefined ? null : permissionsFromString(raw);
    return set !== null && hasPermission(set, permission);
  }

  /** Made the event, or manages meetings where it is. */
  canEdit(e: EventDto): boolean {
    return e.ownerId === this.userId() || this.can(e.spaceId, Permission.MANAGE_MEETINGS);
  }

  /** Reads what the person may do and their settings from the server and keeps them for offline use. */
  async refresh(): Promise<void> {
    const [perms, settings] = await Promise.all([
      firstValueFrom(this.http.get<CalendarPermissionsDto>('/api/calendar-permissions')),
      firstValueFrom(this.http.get<CalendarSettingsDto>('/api/me/calendar-settings')),
    ]);
    const db = this.dbs.db;
    await db.transaction('rw', db.meta, async () => {
      await db.meta.put({ key: PERMS_KEY, value: perms });
      await db.meta.put({ key: SETTINGS_KEY, value: settings });
    });
  }

  async saveSettings(patch: Partial<CalendarSettingsDto>): Promise<void> {
    const next = { ...this.settings(), ...patch };
    await this.dbs.db.meta.put({ key: SETTINGS_KEY, value: next }); // at once, also offline
    try {
      const saved = await firstValueFrom(
        this.http.put<CalendarSettingsDto>('/api/me/calendar-settings', patch),
      );
      await this.dbs.db.meta.put({ key: SETTINGS_KEY, value: saved });
    } catch (e) {
      const p = toProblem(e);
      if (p.status !== 0 && p.status < 500) throw p;
      // offline: kept here; the next change or refresh sends it
    }
  }

  // ------------------------------------------------------------------ the server's side (online)

  /** The event with who is on it and what the person may do (needs a connection). */
  async detail(id: string): Promise<EventDetailDto> {
    const detail = await this.call(() =>
      firstValueFrom(this.http.get<EventDetailDto>(`/api/events/${id}`)),
    );
    if (!(await this.protectedNow()).has(id)) await this.dbs.db.events.put(detail.event);
    return detail;
  }

  /** Reads one event as the server has it (after the server refused a change of ours). */
  async reloadEvent(id: string): Promise<void> {
    try {
      const detail = await firstValueFrom(this.http.get<EventDetailDto>(`/api/events/${id}`));
      await this.dbs.db.events.put(detail.event);
    } catch (e) {
      const p = toProblem(e);
      if (p.status === 404) await this.dbs.db.events.delete(id);
    }
  }

  people(spaceId: string): Promise<CalendarPeopleDto> {
    return this.call(() =>
      firstValueFrom(this.http.get<CalendarPeopleDto>(`/api/spaces/${spaceId}/calendar-people`)),
    );
  }

  async addAttendees(id: string, attendees: AttendeeInput[]): Promise<EventDetailDto> {
    const detail = await this.call(() =>
      firstValueFrom(
        this.http.post<EventDetailDto>(`/api/events/${id}/attendees`, {
          attendees,
        } satisfies AddAttendeesInput),
      ),
    );
    await this.dbs.db.events.put(detail.event);
    return detail;
  }

  async removeAttendee(
    id: string,
    kind: 'user' | 'role',
    subjectId: string,
  ): Promise<EventDetailDto> {
    const detail = await this.call(() =>
      firstValueFrom(
        this.http.delete<EventDetailDto>(`/api/events/${id}/attendees/${kind}/${subjectId}`),
      ),
    );
    await this.dbs.db.events.put(detail.event);
    return detail;
  }

  setReminders(id: string, minutes: number[] | null): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.put(`/api/events/${id}/reminders`, { minutes }));
    });
  }

  duplicate(
    id: string,
    body: { startAt?: string; endAt?: string; spaceId?: string } = {},
  ): Promise<EventDto> {
    return this.call(async () => {
      const event = await firstValueFrom(
        this.http.post<EventDto>(`/api/events/${id}/duplicate`, { id: uuidv7(), ...body }),
      );
      await this.dbs.db.events.put(event);
      return event;
    });
  }

  // ------------------------------------------------------------------ events (offline-capable)

  private async protectedNow(): Promise<Set<string>> {
    return new Set((await this.dbs.db.outbox.toArray()).map((o) => ('id' in o.op ? o.op.id : '')));
  }

  /** Makes an event here at once and queues it. The person is always on their own event (accepted). */
  async createEvent(input: Omit<CreateEventInput, 'id'>): Promise<EventDto> {
    if (
      !this.isPersonalSpace(input.spaceId) &&
      !this.can(input.spaceId, Permission.CREATE_MEETINGS)
    )
      throw new CalendarError('read_only');
    const now = new Date().toISOString();
    const id = uuidv7();
    const others = input.attendees ?? [];
    const row: EventDto = {
      id,
      spaceId: input.spaceId,
      ownerId: this.userId(),
      ownerName: this.auth.user()?.displayName ?? null,
      kind: input.kind ?? 'meeting',
      title: input.title.trim(),
      description: input.description ?? '',
      location: input.location ?? null,
      videoUrl: input.videoUrl ?? null,
      linkedChannelId: input.linkedChannelId ?? null,
      startAt: key(input.startAt),
      endAt: key(input.endAt),
      allDay: input.allDay ?? false,
      timezone: input.allDay ? 'UTC' : (input.timezone ?? 'UTC'),
      rrule: input.rrule ?? null,
      visibility: input.visibility ?? 'attendees',
      exceptions: [],
      attendeeCount: 1 + others.length,
      counts: {
        invited: others.filter((a) => a.kind === 'user').length,
        accepted: 1,
        declined: 0,
        tentative: 0,
      },
      me: { status: 'accepted', addedBy: null, addedByName: null, via: 'owner', optional: false },
      seq: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.dbs.db.events.put(row);
    await this.outbox.enqueue({ opId: uuidv7(), type: 'event.create', id, ...input } as never);
    return row;
  }

  /**
   * Changes an event here at once and queues the change. `all` is the whole event (or series); `this` is one occurrence of a series
   * (it becomes an exception). The rest of a series (`following`) needs the server: see `updateFollowing`.
   */
  async updateEvent(
    id: string,
    patch: Omit<UpdateEventInput, 'scope' | 'occurrence'>,
    scope: Exclude<EditScope, 'following'> = 'all',
    occurrence?: string,
  ): Promise<void> {
    const db = this.dbs.db;
    const row = await db.events.get(id);
    if (!row || row.deletedAt) throw new CalendarError('not_found');
    if (!this.canEdit(row)) throw new CalendarError('read_only');
    const next: EventDto = { ...row, updatedAt: new Date().toISOString() };
    if (scope === 'this' && row.rrule) {
      if (!occurrence) throw new CalendarError('invalid');
      const original = key(occurrence);
      const duration = new Date(row.endAt).getTime() - new Date(row.startAt).getTime();
      const existing = row.exceptions.find((x) => key(x.originalStart) === original);
      const override: EventOverrideDto = {
        ...(existing?.kind === 'override' ? existing.override : {}),
      };
      if (patch.title !== undefined) override.title = patch.title.trim();
      if (patch.description !== undefined) override.description = patch.description;
      if (patch.location !== undefined) override.location = patch.location;
      if (patch.videoUrl !== undefined) override.videoUrl = patch.videoUrl;
      if (patch.startAt !== undefined || patch.endAt !== undefined) {
        const start = patch.startAt ?? override.startAt ?? original;
        override.startAt = key(start);
        override.endAt = key(
          patch.endAt ??
            (patch.startAt
              ? new Date(new Date(start).getTime() + duration).toISOString()
              : (override.endAt ?? new Date(new Date(start).getTime() + duration).toISOString())),
        );
      }
      const x: EventExceptionDto = { originalStart: original, kind: 'override', override };
      next.exceptions = [...row.exceptions.filter((e) => key(e.originalStart) !== original), x];
      await db.events.put(next);
      await this.outbox.enqueue({
        opId: uuidv7(),
        type: 'event.update',
        id,
        scope: 'this',
        occurrence: original,
        ...patch,
      } as never);
      return;
    }
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.location !== undefined) next.location = patch.location;
    if (patch.videoUrl !== undefined) next.videoUrl = patch.videoUrl;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.visibility !== undefined) next.visibility = patch.visibility;
    if (patch.linkedChannelId !== undefined) next.linkedChannelId = patch.linkedChannelId;
    if (patch.allDay !== undefined) next.allDay = patch.allDay;
    if (patch.startAt !== undefined) next.startAt = key(patch.startAt);
    if (patch.endAt !== undefined) next.endAt = key(patch.endAt);
    if (patch.timezone !== undefined) next.timezone = next.allDay ? 'UTC' : patch.timezone;
    if (next.allDay) next.timezone = 'UTC';
    if (patch.rrule !== undefined) next.rrule = patch.rrule;
    // The server forgets what it knew of single occurrences when the time or the rule moves; so does this copy.
    if (
      ['startAt', 'allDay', 'timezone', 'rrule'].some(
        (k) => (patch as Record<string, unknown>)[k] !== undefined,
      )
    )
      next.exceptions = [];
    await db.events.put(next);
    await this.outbox.enqueue({ opId: uuidv7(), type: 'event.update', id, ...patch } as never);
  }

  /** Changes an occurrence and every later one (online: the server splits the series). */
  updateFollowing(
    id: string,
    occurrence: string,
    patch: Omit<UpdateEventInput, 'scope' | 'occurrence'>,
  ): Promise<EventDto> {
    return this.call(async () => {
      const event = await firstValueFrom(
        this.http.patch<EventDto>(`/api/events/${id}`, {
          ...patch,
          scope: 'following',
          occurrence,
        }),
      );
      this.sync();
      await this.dbs.db.events.put(event);
      return event;
    });
  }

  /** Cancels an occurrence, or the whole event. */
  async cancelEvent(
    id: string,
    scope: Exclude<EditScope, 'following'> = 'all',
    occurrence?: string,
  ): Promise<void> {
    const db = this.dbs.db;
    const row = await db.events.get(id);
    if (!row || row.deletedAt) throw new CalendarError('not_found');
    if (!this.canEdit(row)) throw new CalendarError('read_only');
    if (scope === 'this' && row.rrule) {
      if (!occurrence) throw new CalendarError('invalid');
      const original = key(occurrence);
      const exceptions = [
        ...row.exceptions.filter((e) => key(e.originalStart) !== original),
        { originalStart: original, kind: 'cancelled' as const },
      ];
      await db.events.put({ ...row, exceptions, updatedAt: new Date().toISOString() });
      await this.outbox.enqueue({
        opId: uuidv7(),
        type: 'event.cancel',
        id,
        scope: 'this',
        occurrence: original,
      });
      return;
    }
    await db.events.put({ ...row, deletedAt: new Date().toISOString() });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'event.cancel', id, scope: 'all' });
  }

  /** The rest of a series from an occurrence on (online). */
  cancelFollowing(id: string, occurrence: string): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(
        this.http.delete(`/api/events/${id}`, { params: { scope: 'following', occurrence } }),
      );
      this.sync();
    });
  }

  /** Accepts, declines or answers "maybe", here at once and queued. */
  async rsvp(id: string, status: RsvpAnswer): Promise<void> {
    const db = this.dbs.db;
    const row = await db.events.get(id);
    if (!row || !row.me) throw new CalendarError('not_found');
    const counts: RsvpCountsDto = { ...row.counts };
    if (row.me.via !== 'role' || row.me.status !== 'invited')
      counts[row.me.status] = Math.max(0, counts[row.me.status] - 1);
    counts[status]++;
    await db.events.put({
      ...row,
      me: { ...row.me, status, via: row.me.via === 'role' ? 'user' : row.me.via },
      counts,
    });
    await this.outbox.enqueue({ opId: uuidv7(), type: 'event.rsvp', id, status, scope: 'all' });
  }

  /** Events the person may no longer see: forget them. */
  async dropEvents(ids: string[]): Promise<void> {
    if (ids.length) await this.dbs.db.events.bulkDelete(ids);
  }
}
