import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

/**
 * What services announce. Controllers and services never talk to the realtime gateway: they publish one of these
 * and the RealtimeBridge decides which rooms hear about it. Later phases add their events here (messages, tasks, ...).
 */
export interface DomainEventMap {
  /** A change recorded in a team's audit log (the same entry the log shows). Drives room revocation. */
  'team.audited': {
    teamId: string;
    action: string;
    targetKind: string;
    targetId: string;
    actorId: string | null;
    after: unknown;
  };
  /** Tell these people to refresh what they may do (and re-check the rooms they are in). */
  'permissions.changed': { userIds: string[]; teamId?: string };
  /** A space's data changed up to `seq`: its members should pull sync now. */
  'space.changed': { spaceId: string; seq: string };
  /** A login ended: close the sockets of that session (all of the person's sessions when `sessionId` is absent, except `exceptSessionId`). */
  'session.revoked': {
    userId: string;
    sessionId?: string;
    exceptSessionId?: string;
    reason: 'signed_out' | 'password_changed' | 'revoked';
  };
  /** The person changed who sees them online. */
  'presence.mode': { userId: string };
  /** A person leaves or gains a team: their socket must join or leave its rooms. */
  'membership.changed': { userId: string };
  /** A page's document was stored from its co-editing session (the stored JSON, text, size and version changed). */
  'page.updated': { pageId: string; spaceId: string; version: number };
  /** A voice channel was archived, changed or deleted (the media server must hear about it). */
  'channel.changed': { channelId: string; deleted: boolean };
  /** Anything else a feature wants delivered to rooms: `name` goes to every room in `rooms`. */
  'room.event': { rooms: string[]; name: string; payload: unknown; except?: string[] };
}

export type DomainEventType = keyof DomainEventMap;
type Handler<K extends DomainEventType> = (payload: DomainEventMap[K]) => void | Promise<void>;

/**
 * An in-process publish/subscribe bus with typed events. `publish` resolves once every subscriber has finished, so
 * code that needs a consequence in place before it answers (a revoked person must no longer receive events) can wait.
 * A failing subscriber is logged and never breaks the publisher or the other subscribers.
 */
@Injectable()
export class EventBus {
  private readonly log = new Logger(EventBus.name);
  private readonly handlers = new Map<DomainEventType, Set<Handler<never>>>();

  constructor(private readonly prisma: PrismaService) {}

  subscribe<K extends DomainEventType>(type: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as Handler<never>);
    this.handlers.set(type, set);
    return () => set.delete(handler as Handler<never>);
  }

  async publish<K extends DomainEventType>(type: K, payload: DomainEventMap[K]): Promise<void> {
    const set = this.handlers.get(type);
    if (!set?.size) return;
    await Promise.all(
      [...set].map(async (handler) => {
        try {
          await (handler as Handler<K>)(payload);
        } catch (e) {
          this.log.error(`subscriber of ${type} failed: ${e instanceof Error ? e.stack : e}`);
        }
      }),
    );
  }

  /** Publishes when the transaction commits (and not at all if it rolls back). */
  publishAfterCommit<K extends DomainEventType>(tx: Tx, type: K, payload: DomainEventMap[K]): void {
    this.prisma.afterCommit(tx, () => this.publish(type, payload));
  }
}
