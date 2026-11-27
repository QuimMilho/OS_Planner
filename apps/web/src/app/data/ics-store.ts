import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  CalendarDto,
  CalendarFeedDto,
  CalendarFeedSecretDto,
  CalendarItemDto,
  ExternalCalendarDto,
  FeedIncludeDto,
  IcsImportPreviewDto,
  IcsImportResultDto,
} from '@os-planner/shared';

/** Largest calendar file the server takes (the same figure as `ICS_LIMITS.maxBytes`). */
export const MAX_ICS_BYTES = 5 * 1024 * 1024;

/**
 * Calendar files (phase 14): the private subscription feeds, the calendars the person follows, import and export. These need the
 * server (they are about the world outside), so nothing here is queued offline: when the server cannot be reached the calls fail and
 * the screens say so. The events of followed calendars are read for the window being looked at and kept only in memory.
 */
@Injectable({ providedIn: 'root' })
export class IcsStore {
  private readonly http = inject(HttpClient);

  readonly feeds = signal<CalendarFeedDto[]>([]);
  readonly calendars = signal<ExternalCalendarDto[]>([]);
  /** Entries of followed calendars for the window last asked for. */
  readonly items = signal<CalendarItemDto[]>([]);
  private windowKey = '';
  /** The newest request for a window: an older answer that arrives late must not replace it. */
  private latest = 0;

  // ---------------------------------------------------------------- feeds

  async loadFeeds(): Promise<void> {
    this.feeds.set(await firstValueFrom(this.http.get<CalendarFeedDto[]>('/api/me/feeds')));
  }

  async createFeed(name: string, include: Partial<FeedIncludeDto>): Promise<CalendarFeedSecretDto> {
    const made = await firstValueFrom(
      this.http.post<CalendarFeedSecretDto>('/api/me/feeds', { name, include }),
    );
    await this.loadFeeds();
    return made;
  }

  async updateFeed(
    id: string,
    patch: { name?: string; include?: Partial<FeedIncludeDto> },
  ): Promise<void> {
    await firstValueFrom(this.http.patch<CalendarFeedDto>(`/api/me/feeds/${id}`, patch));
    await this.loadFeeds();
  }

  async rotateFeed(id: string): Promise<CalendarFeedSecretDto> {
    const made = await firstValueFrom(
      this.http.post<CalendarFeedSecretDto>(`/api/me/feeds/${id}/rotate`, {}),
    );
    await this.loadFeeds();
    return made;
  }

  async removeFeed(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/me/feeds/${id}`));
    await this.loadFeeds();
  }

  // ---------------------------------------------------------------- followed calendars

  async loadCalendars(): Promise<void> {
    this.calendars.set(
      await firstValueFrom(this.http.get<ExternalCalendarDto[]>('/api/me/external-calendars')),
    );
  }

  async follow(input: {
    name: string;
    url: string;
    color: string;
    syncEveryMinutes: number;
  }): Promise<void> {
    await firstValueFrom(this.http.post<ExternalCalendarDto>('/api/me/external-calendars', input));
    await this.loadCalendars();
    this.forget();
  }

  async updateCalendar(
    id: string,
    patch: { name?: string; color?: string; enabled?: boolean; syncEveryMinutes?: number },
  ): Promise<void> {
    await firstValueFrom(
      this.http.patch<ExternalCalendarDto>(`/api/me/external-calendars/${id}`, patch),
    );
    await this.loadCalendars();
    this.forget();
  }

  async refresh(id: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<ExternalCalendarDto>(`/api/me/external-calendars/${id}/refresh`, {}),
      );
    } finally {
      await this.loadCalendars();
      this.forget();
    }
  }

  async unfollow(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/me/external-calendars/${id}`));
    await this.loadCalendars();
    this.forget();
  }

  /** What was read for a window is out of date (a calendar was added, changed or refreshed). */
  private forget(): void {
    this.windowKey = '';
  }

  /** The followed calendars' entries between two instants, kept for the screen. A failure keeps what was shown. */
  async loadWindow(fromIso: string, toIso: string): Promise<void> {
    const key = `${fromIso}|${toIso}`;
    if (key === this.windowKey) return;
    const mine = ++this.latest;
    try {
      const res = await firstValueFrom(
        this.http.get<CalendarDto>('/api/calendar', {
          params: { from: fromIso, to: toIso, include: 'external' },
        }),
      );
      if (mine !== this.latest) return;
      this.items.set(res.items);
      this.windowKey = key;
    } catch {
      /* offline or refused: the entries already on screen stay */
    }
  }

  // ---------------------------------------------------------------- import and export

  async importFile(
    file: File,
    mode: 'preview' | 'commit',
    spaceId: string | null,
    uids?: readonly string[],
  ): Promise<IcsImportPreviewDto | IcsImportResultDto> {
    const body = new FormData();
    body.append('mode', mode);
    if (spaceId) body.append('spaceId', spaceId);
    if (uids) body.append('uids', JSON.stringify(uids));
    body.append('file', file, file.name);
    return firstValueFrom(
      this.http.post<IcsImportPreviewDto | IcsImportResultDto>('/api/calendar/import', body),
    );
  }

  /** Downloads what the calendar shows between two days as a file. */
  async exportRange(fromIso: string, toIso: string): Promise<Blob> {
    return firstValueFrom(
      this.http.get('/api/calendar/export', {
        params: { from: fromIso, to: toIso },
        responseType: 'blob',
      }),
    );
  }

  async exportEvent(id: string): Promise<Blob> {
    return firstValueFrom(this.http.get(`/api/events/${id}.ics`, { responseType: 'blob' }));
  }
}
