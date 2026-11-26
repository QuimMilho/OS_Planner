import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { MessageDto } from '@os-planner/shared';
import { isUnreachable, toProblem } from '../core/auth-store';
import { RealtimeService } from '../core/realtime';
import { ChatStore } from './chat-store';
import { Db, type ChatOutboxRow } from './db';

const TICK_MS = 4_000;
/** The newest messages kept per channel for reading offline. */
export const CACHE_PER_CHANNEL = 200;

/**
 * Sends messages in the order they were written. A message is written to the local outbox first (so it survives a closed
 * tab or a lost connection) and then sent under its own id; the server treats a resend of the same id as the same message,
 * so trying again is always safe. Network trouble leaves it queued; a refusal marks it failed, for the person to retry or drop.
 */
@Injectable({ providedIn: 'root' })
export class ChatSender {
  private readonly http = inject(HttpClient);
  private readonly dbs = inject(Db);
  private readonly store = inject(ChatStore);
  private running = false;
  private again = false;

  constructor() {
    const rt = inject(RealtimeService);
    rt.resumed.subscribe(() => void this.flush());
    addEventListener('online', () => void this.flush());
    setInterval(() => void this.flush(), TICK_MS);
  }

  async enqueue(row: ChatOutboxRow): Promise<void> {
    await this.dbs.db.chatOutbox.add(row);
    void this.flush();
  }

  async retry(id: string): Promise<void> {
    await this.dbs.db.chatOutbox.update(id, {
      state: 'queued',
      error: undefined,
      retryAt: undefined,
    });
    void this.flush();
  }

  async discard(id: string): Promise<void> {
    await this.dbs.db.chatOutbox.delete(id);
  }

  /** Sends what is waiting. One run at a time; a request for another while one is running makes it go round again. */
  async flush(): Promise<void> {
    if (!this.dbs.current()) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.sendAll();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async sendAll(): Promise<void> {
    const db = this.dbs.current();
    if (!db) return;
    const waiting = (await db.chatOutbox.orderBy('createdAt').toArray()).filter(
      (r) => r.state === 'queued',
    );
    // A channel whose oldest message cannot go yet (slowmode, a lost connection) holds back its later ones, so order stays.
    const held = new Set<string>();
    for (const row of waiting) {
      if (held.has(row.channelId)) continue;
      if (row.retryAt && row.retryAt > Date.now()) {
        held.add(row.channelId);
        continue;
      }
      try {
        const sent = await firstValueFrom(
          this.http.post<MessageDto>(`/api/channels/${row.channelId}/messages`, {
            id: row.id,
            content: row.content,
            replyToId: row.replyToId,
            threadId: row.threadId,
            attachmentIds: row.attachmentIds,
          }),
        );
        await db.chatMessages.put(sent);
        await db.chatOutbox.delete(row.id);
        this.store.sent.next(sent);
      } catch (e) {
        if (isUnreachable(e)) return; // no connection: everything stays queued, try again later
        const problem = toProblem(e);
        const retryAfter = (problem.details as { retryAfter?: number } | null)?.retryAfter;
        if (problem.status === 429) {
          await db.chatOutbox.update(row.id, {
            retryAt: Date.now() + Math.max(1, retryAfter ?? 5) * 1000,
          });
          held.add(row.channelId);
        } else if (problem.status >= 500) {
          held.add(row.channelId); // the server is having trouble: not the message's fault
        } else {
          await db.chatOutbox.update(row.id, { state: 'failed', error: problem.code });
        }
      }
    }
  }
}
