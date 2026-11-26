import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { MessageDto, ThreadSummaryDto } from '@os-planner/shared';
import { toProblem } from '../core/auth-store';
import { Notify } from '../core/notify';
import { Dialogs } from '../shared/dialogs';

/** The text to show for something the server refused, from its error code. */
export function chatErrorKey(code: string, status = 0): string {
  switch (code) {
    case 'offline':
      return 'common.offlineAction';
    case 'forbidden':
    case 'permission_not_held':
      return 'errors.forbidden';
    case 'dm_not_allowed':
      return 'dm.notAllowed';
    case 'slowmode':
      return 'errors.slowmode';
    case 'rate_limited':
      return 'errors.rateLimited';
    case 'quota_exceeded':
      return 'errors.quotaExceeded';
    case 'channel_archived':
      return 'chat.archivedNotice';
    case 'thread_archived':
      return 'thread.archivedNotice';
    case 'unsupported_media_type':
      return 'attachment.unsupported';
    case 'image_too_large':
    case 'video_too_large':
      return 'attachment.tooLarge';
    default:
      return status === 400 || status === 422 ? 'errors.messageInvalid' : 'errors.generic';
  }
}

/**
 * What a person does to a message that is already on the server: react, edit, delete, pin, start a thread. Each call goes to
 * the server and returns what it answered; the screen applies that (the same change also arrives as a live event, and
 * applying it twice is harmless). Failures are shown to the person here.
 */
@Injectable({ providedIn: 'root' })
export class ChatActions {
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);

  private async run<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      const problem = toProblem(e);
      this.notify.error(chatErrorKey(problem.code, problem.status));
      return null;
    }
  }

  async react(messageId: string, emoji: string, on: boolean): Promise<boolean> {
    const url = `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;
    return (
      (await this.run(
        async () => (
          await firstValueFrom(on ? this.http.put(url, null) : this.http.delete(url)),
          true
        ),
      )) ?? false
    );
  }

  edit(messageId: string, content: string): Promise<MessageDto | null> {
    return this.run(() =>
      firstValueFrom(this.http.patch<MessageDto>(`/api/messages/${messageId}`, { content })),
    );
  }

  /** Asks first. True when the message is gone. */
  async remove(messageId: string): Promise<boolean> {
    const ok = await this.dialogs.confirm({
      titleKey: 'chat.deleteTitle',
      messageKey: 'chat.deleteConfirm',
      confirmKey: 'common.delete',
      danger: true,
    });
    if (!ok) return false;
    return (
      (await this.run(
        async () => (await firstValueFrom(this.http.delete(`/api/messages/${messageId}`)), true),
      )) ?? false
    );
  }

  pin(messageId: string, on: boolean): Promise<MessageDto | null> {
    const url = `/api/messages/${messageId}/pin`;
    return this.run(() =>
      firstValueFrom(on ? this.http.put<MessageDto>(url, null) : this.http.delete<MessageDto>(url)),
    );
  }

  startThread(messageId: string, name: string): Promise<ThreadSummaryDto | null> {
    return this.run(() =>
      firstValueFrom(
        this.http.post<ThreadSummaryDto>(`/api/messages/${messageId}/thread`, { name }),
      ),
    );
  }

  setThreadArchived(threadId: string, archived: boolean): Promise<ThreadSummaryDto | null> {
    return this.run(() =>
      firstValueFrom(this.http.patch<ThreadSummaryDto>(`/api/threads/${threadId}`, { archived })),
    );
  }
}
