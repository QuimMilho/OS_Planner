import { Injectable } from '@nestjs/common';
import { hasPermission, Permission } from '@os-planner/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService, type SpaceAccess } from '../spaces/permission.service.js';
import { forbidden, notFound } from '../tree/tree.error.js';
import { canSee, EVENT_INCLUDE, type EventRow, type Viewer } from './event-views.js';

/** An event together with what the person asking may do with it. */
export interface EventContext {
  event: EventRow;
  space: SpaceAccess;
  viewer: Viewer;
  personal: boolean;
  /** Made the event, or holds MANAGE_MEETINGS in its space: may change or cancel it. */
  canEdit: boolean;
  /** May name other people and roles on it (ADD_TO_MEMBER_CALENDARS; a personal event has nobody to name). */
  canInvite: boolean;
}

/** Finds an event for a person: 404 when its space's calendar, or the event itself, is not theirs to see. */
@Injectable()
export class EventAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  /** The viewer's side of a space: the roles they hold and whether they manage its meetings. */
  async viewerIn(userId: string, space: SpaceAccess): Promise<Viewer> {
    return {
      userId,
      held: await this.perms.heldRoleIds(userId),
      manager:
        space.space.kind === 'personal' || hasPermission(space.perms, Permission.MANAGE_MEETINGS),
    };
  }

  /** The event (trashed ones too: callers decide) and the person's rights. */
  async forUser(userId: string, eventId: string): Promise<EventContext> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: EVENT_INCLUDE,
    });
    if (!event) throw notFound();
    const space = await this.perms.spaceAccess(userId, event.spaceId);
    if (!space || !hasPermission(space.perms, Permission.VIEW_CALENDAR)) throw notFound();
    const viewer = await this.viewerIn(userId, space);
    if (!canSee(event, viewer)) throw notFound();
    const personal = space.space.kind === 'personal';
    return {
      event,
      space,
      viewer,
      personal,
      canEdit:
        event.ownerId === userId ||
        (!personal && hasPermission(space.perms, Permission.MANAGE_MEETINGS)) ||
        personal,
      canInvite: !personal && hasPermission(space.perms, Permission.ADD_TO_MEMBER_CALENDARS),
    };
  }

  /** The event must be there (not cancelled). */
  live(ctx: EventContext): EventContext {
    if (ctx.event.deletedAt) throw notFound();
    return ctx;
  }

  assertCanEdit(ctx: EventContext): void {
    if (!ctx.canEdit) throw forbidden();
  }
}
