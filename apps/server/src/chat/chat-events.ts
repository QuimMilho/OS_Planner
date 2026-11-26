import { Injectable } from '@nestjs/common';
import { type ChannelsChangedEvent } from '@os-planner/shared';
import { CHAT_EVENTS } from '@os-planner/shared/chat';
import { EventBus } from '../events/event-bus.js';
import type { Tx } from '../prisma/prisma.service.js';

export const channelRoom = (channelId: string): string => `channel:${channelId}`;
export const threadRoom = (threadId: string): string => `thread:${threadId}`;
export const spaceRoom = (spaceId: string): string => `space:${spaceId}`;
export const userRoomOf = (userId: string): string => `user:${userId}`;

/**
 * What chat tells the rooms. Services call these inside their transaction; the events go out once it has committed (and
 * not at all if it rolled back), so nobody hears about a message that does not exist.
 */
@Injectable()
export class ChatEvents {
  constructor(private readonly bus: EventBus) {}

  toChannel(tx: Tx, channelId: string, name: string, payload: unknown): void {
    this.bus.publishAfterCommit(tx, 'room.event', {
      rooms: [channelRoom(channelId)],
      name,
      payload,
    });
  }

  toThread(tx: Tx, threadId: string, name: string, payload: unknown): void {
    this.bus.publishAfterCommit(tx, 'room.event', { rooms: [threadRoom(threadId)], name, payload });
  }

  /** Tells one person (every device they have open). */
  toUser(tx: Tx, userId: string, name: string, payload: unknown): void {
    this.bus.publishAfterCommit(tx, 'room.event', { rooms: [userRoomOf(userId)], name, payload });
  }

  /** The list of channels of a space changed: people in the space ask for it again (each gets what they may see). */
  channelsChanged(tx: Tx, spaceId: string): void {
    const payload: ChannelsChangedEvent = { spaceId };
    this.bus.publishAfterCommit(tx, 'room.event', {
      rooms: [spaceRoom(spaceId)],
      name: CHAT_EVENTS.channelsChanged,
      payload,
    });
  }
}
