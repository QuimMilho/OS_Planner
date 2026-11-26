import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { MailActionResultDto } from '@os-planner/shared';

/**
 * The page behind the links in a notification email ("mute this chat", "stop emails about it"). No login: the signed link
 * says who and what. It applies the change as soon as it opens, and says what it did.
 */
@Component({
  selector: 'app-mail-action',
  imports: [RouterLink, MatIconModule, TranslocoPipe],
  template: `
    <main class="box" data-mail-action>
      @switch (state()) {
        @case ('working') {
          <p role="status">{{ 'common.loading' | transloco }}</p>
        }
        @case ('done') {
          <mat-icon class="ok" aria-hidden="true">check_circle</mat-icon>
          <h1>
            {{
              (result()?.action === 'mute' ? 'mail.action.muted' : 'mail.action.unsubscribed')
                | transloco
            }}
          </h1>
          <p>{{ 'mail.action.note' | transloco }}</p>
        }
        @default {
          <mat-icon class="bad" aria-hidden="true">error</mat-icon>
          <h1>{{ 'mail.action.invalid' | transloco }}</h1>
          <p>{{ 'mail.action.invalidNote' | transloco }}</p>
        }
      }
      <a routerLink="/app" data-mail-action-open>{{ 'mail.action.open' | transloco }}</a>
    </main>
  `,
  styles: `
    .box {
      max-width: 460px;
      margin: 12vh auto;
      padding: 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    h1 {
      font-size: 22px;
      margin: 0;
    }
    p {
      color: var(--text-dim);
      margin: 0 0 12px;
    }
    .ok {
      color: #2f9e44;
      width: 48px;
      height: 48px;
      font-size: 48px;
    }
    .bad {
      color: var(--mat-sys-error);
      width: 48px;
      height: 48px;
      font-size: 48px;
    }
  `,
})
export class MailAction implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  protected readonly state = signal<'working' | 'done' | 'invalid'>('working');
  protected readonly result = signal<MailActionResultDto | null>(null);

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token) return void this.state.set('invalid');
    try {
      this.result.set(
        await firstValueFrom(
          this.http.post<MailActionResultDto>('/api/mail/unsubscribe', { token }),
        ),
      );
      this.state.set('done');
    } catch {
      this.state.set('invalid');
    }
  }
}
