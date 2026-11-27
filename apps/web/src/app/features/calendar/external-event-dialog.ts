import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Language } from '../../core/i18n';
import type { Entry } from './cal-util';

export interface ExternalEventData {
  entry: Entry;
  tz: string;
}

/** An event of a calendar the person follows: what it says, where it comes from, and a link to its page. Nothing here can be changed. */
@Component({
  selector: 'app-external-event-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title data-external-title>{{ data.entry.title }}</h2>
    <mat-dialog-content>
      <p class="from">
        <span class="dot" [style.background]="data.entry.color"></span>
        <mat-icon class="lock">lock</mat-icon>
        <span>{{ 'calendar.external.from' | transloco: { name: data.entry.sourceName } }}</span>
      </p>
      <p class="when" data-external-when>{{ when() }}</p>
      @if (data.entry.location) {
        <p class="where"><mat-icon>place</mat-icon>{{ data.entry.location }}</p>
      }
      @if (data.entry.note) {
        <p class="note">{{ data.entry.note }}</p>
      }
      <p class="muted">{{ 'calendar.external.readOnly' | transloco }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (data.entry.url) {
        <a
          mat-button
          [href]="data.entry.url"
          target="_blank"
          rel="noopener noreferrer nofollow"
          data-external-open
        >
          <mat-icon>open_in_new</mat-icon>{{ 'calendar.external.open' | transloco }}
        </a>
      }
      <button mat-button type="button" mat-dialog-close>{{ 'common.close' | transloco }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .from,
    .where {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 6px;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .lock,
    .where mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .when {
      font-weight: 600;
      margin: 0 0 6px;
    }
    .note {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .muted {
      color: var(--text-dim);
      font-size: 13px;
    }
  `,
})
export class ExternalEventDialog {
  protected readonly data = inject<ExternalEventData>(MAT_DIALOG_DATA);
  private readonly lang = inject(Language);

  protected when(): string {
    const e = this.data.entry;
    const locale = this.lang.current === 'pt' ? 'pt-PT' : 'en-GB';
    if (e.allDay) {
      const f = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
      const last = Math.max(e.startMs, e.endMs - 1);
      return f.format(e.startMs) === f.format(last)
        ? f.format(e.startMs)
        : `${f.format(e.startMs)} – ${f.format(last)}`;
    }
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: this.data.tz });
    const time = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: this.data.tz,
    });
    return day.format(e.startMs) === day.format(e.endMs)
      ? `${day.format(e.startMs)}, ${time.format(e.startMs)} – ${time.format(e.endMs)}`
      : `${day.format(e.startMs)} ${time.format(e.startMs)} – ${day.format(e.endMs)} ${time.format(e.endMs)}`;
  }
}
