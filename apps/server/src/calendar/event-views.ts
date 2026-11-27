import type {
  EventDto,
  EventExceptionDto,
  EventKind,
  EventOverrideDto,
  EventVisibility,
  MyAttendanceDto,
  RsvpCountsDto,
  RsvpStatus,
} from '@os-planner/shared';
import { fieldSeqDto } from '../common/merge-scope.js';
import type { Event, EventAttendee, EventException } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** An event with what travels inside it: who is named on it and which occurrences differ. */
export type EventRow = Event & { attendees: EventAttendee[]; exceptions: EventException[] };

export const EVENT_INCLUDE = { attendees: true, exceptions: true } as const;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Who is looking: what decides which rows they see and what "me" is. */
export interface Viewer {
  userId: string;
  /** Ids of the roles they hold. */
  held: ReadonlySet<string>;
  /** MANAGE_MEETINGS in the event's space (sees and changes everything there). */
  manager: boolean;
}

/** The people on an event that this person sees it through, in order: themselves, then a role they hold. */
export function myRow(
  row: Pick<EventRow, 'attendees'>,
  viewer: Pick<Viewer, 'userId' | 'held'>,
): EventAttendee | null {
  const own = row.attendees.find((a) => a.kind === 'user' && a.subjectId === viewer.userId);
  if (own) return own;
  return row.attendees.find((a) => a.kind === 'role' && viewer.held.has(a.subjectId)) ?? null;
}

/** May this person see the event (the space's calendar is theirs to see: callers check that first)? */
export function canSee(
  row: Pick<EventRow, 'ownerId' | 'visibility' | 'attendees'>,
  viewer: Viewer,
): boolean {
  return (
    row.ownerId === viewer.userId ||
    viewer.manager ||
    row.visibility === 'space' ||
    myRow(row, viewer) !== null
  );
}

export const counts = (attendees: readonly EventAttendee[]): RsvpCountsDto => {
  const out: RsvpCountsDto = { invited: 0, accepted: 0, declined: 0, tentative: 0 };
  for (const a of attendees) if (a.kind === 'user') out[a.status as RsvpStatus]++;
  return out;
};

/** Display names for a set of people, in one query. */
export async function namesOf(
  prisma: Pick<PrismaService, 'user'>,
  ids: Iterable<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((i): i is string => !!i))];
  if (!wanted.length) return new Map();
  return new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
}

/** The names a batch of events needs (owners, and whoever put the viewer on them). */
export function namesNeeded(
  rows: readonly EventRow[],
  viewer: Pick<Viewer, 'userId' | 'held'>,
): string[] {
  const ids: (string | null)[] = [];
  for (const r of rows) {
    ids.push(r.ownerId);
    const mine = myRow(r, viewer);
    if (mine) ids.push(mine.addedBy);
  }
  return ids.filter((i): i is string => !!i);
}

export function toExceptionDto(x: EventException): EventExceptionDto {
  return {
    originalStart: x.originalStart.toISOString(),
    kind: x.kind === 'cancelled' ? 'cancelled' : 'override',
    ...(x.override ? { override: x.override as EventOverrideDto } : {}),
  };
}

export function toEventDto(
  row: EventRow,
  viewer: Pick<Viewer, 'userId' | 'held'>,
  names: ReadonlyMap<string, string>,
): EventDto {
  const mine = myRow(row, viewer);
  let me: MyAttendanceDto | null = null;
  if (mine) {
    me = {
      status: mine.status as RsvpStatus,
      addedBy: mine.addedBy,
      addedByName: mine.addedBy ? (names.get(mine.addedBy) ?? null) : null,
      via: row.ownerId === viewer.userId ? 'owner' : mine.kind === 'role' ? 'role' : 'user',
      optional: mine.optional,
    };
  } else if (row.ownerId === viewer.userId)
    me = { status: 'accepted', addedBy: null, addedByName: null, via: 'owner', optional: false };
  return {
    id: row.id,
    spaceId: row.spaceId,
    ownerId: row.ownerId,
    ownerName: row.ownerId ? (names.get(row.ownerId) ?? null) : null,
    kind: row.kind as EventKind,
    title: row.title,
    description: row.description,
    location: row.location,
    videoUrl: row.videoUrl,
    linkedChannelId: row.linkedChannelId,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    allDay: row.allDay,
    timezone: row.timezone,
    rrule: row.rrule,
    visibility: row.visibility as EventVisibility,
    exceptions: row.exceptions
      .map(toExceptionDto)
      .sort((a, b) => (a.originalStart < b.originalStart ? -1 : 1)),
    attendeeCount: row.attendees.length,
    counts: counts(row.attendees),
    me,
    seq: Number(row.seq),
    ...fieldSeqDto(row.fieldSeq),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}

/** Size an event counts for in the space storage: its text fields, its rule and what its exceptions change. */
export function eventBytes(
  e: {
    title: string;
    description: string;
    location: string | null;
    videoUrl: string | null;
    rrule: string | null;
  },
  exceptions: readonly { override?: unknown }[] = [],
): number {
  let n = Buffer.byteLength(e.title, 'utf8') + Buffer.byteLength(e.description, 'utf8') + 64;
  if (e.location) n += Buffer.byteLength(e.location, 'utf8');
  if (e.videoUrl) n += Buffer.byteLength(e.videoUrl, 'utf8');
  if (e.rrule) n += Buffer.byteLength(e.rrule, 'utf8');
  for (const x of exceptions)
    n += 32 + (x.override ? Buffer.byteLength(JSON.stringify(x.override), 'utf8') : 0);
  return n;
}
