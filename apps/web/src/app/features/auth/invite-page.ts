import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslocoPipe } from '@jsverse/transloco';
import type { InvitePreviewDto } from '@os-planner/shared';
import { AuthStore, toProblem } from '../../core/auth-store';
import { MembershipStore } from '../../data/membership-store';

type State = 'loading' | 'invalid' | 'ready';

/**
 * `/invite/<token>`: what somebody sees when they open an invitation. A visitor learns the team's name and size and
 * nothing else (who is in it stays hidden until they have joined); from here they create an account or sign in, and
 * come back to this page to join. An address that is not signed in never reaches the app.
 */
@Component({
  selector: 'app-invite-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatProgressSpinnerModule, TranslocoPipe],
  template: `
    <main class="auth-page">
      <div class="auth-card center" data-invite-page>
        <a class="brand" routerLink="/"><img src="favicon.svg" alt="" />OS_Planner</a>
        @switch (state()) {
          @case ('loading') {
            <mat-spinner diameter="36" />
          }
          @case ('invalid') {
            <mat-icon class="big bad">link_off</mat-icon>
            <h1 data-invite-invalid>{{ 'invite.invalidTitle' | transloco }}</h1>
            <p class="muted">{{ 'invite.invalidText' | transloco }}</p>
            <a mat-stroked-button routerLink="/app">{{ 'auth.continue' | transloco }}</a>
          }
          @case ('ready') {
            <span class="icon" [style.background]="preview()?.color">{{ initial() }}</span>
            <p class="muted">{{ 'invite.invitedTo' | transloco }}</p>
            <h1 data-invite-team>{{ preview()?.teamName }}</h1>
            <p class="muted" data-invite-size>
              {{ 'invite.members' | transloco: { count: preview()?.memberCount } }}
            </p>

            @if (error()) {
              <p class="error" role="alert" data-invite-error>{{ error() | transloco }}</p>
            }

            @if (auth.status() === 'loading') {
              <mat-spinner diameter="24" />
            } @else if (auth.status() === 'anon') {
              <a
                mat-flat-button
                [routerLink]="['/register']"
                [queryParams]="{ invite: token() }"
                data-action="invite-register"
                >{{ 'invite.createAccount' | transloco }}</a
              >
              <a
                mat-stroked-button
                [routerLink]="['/login']"
                [queryParams]="{ returnUrl: '/invite/' + token() }"
                data-action="invite-login"
                >{{ 'invite.signIn' | transloco }}</a
              >
            } @else if (!auth.user()?.emailVerified) {
              <p data-invite-verify>{{ 'invite.verifyFirst' | transloco }}</p>
              <a mat-stroked-button routerLink="/app">{{ 'auth.continue' | transloco }}</a>
            } @else {
              <button
                mat-flat-button
                type="button"
                [disabled]="busy()"
                (click)="join()"
                data-action="invite-join"
              >
                {{ 'invite.join' | transloco }}
              </button>
              @if (otherAddress()) {
                <button
                  mat-stroked-button
                  type="button"
                  (click)="signOut()"
                  data-action="invite-signout"
                >
                  {{ 'invite.signOut' | transloco }}
                </button>
              }
            }
          }
        }
      </div>
    </main>
  `,
  styles: `
    .center {
      align-items: center;
      text-align: center;
    }
    .big {
      font-size: 56px;
      width: 56px;
      height: 56px;
    }
    .bad {
      color: var(--mat-sys-error);
    }
    .icon {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      border-radius: 18px;
      background: var(--accent);
      color: #fff;
      font-size: 28px;
      font-weight: 700;
    }
    h1 {
      margin: 0;
      overflow-wrap: anywhere;
    }
    p {
      margin: 0;
    }
  `,
})
export class InvitePage implements OnInit {
  protected readonly auth = inject(AuthStore);
  private readonly membership = inject(MembershipStore);
  private readonly router = inject(Router);

  readonly token = input.required<string>();
  protected readonly state = signal<State>('loading');
  protected readonly preview = signal<InvitePreviewDto | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly otherAddress = signal(false);
  protected readonly initial = computed(() =>
    (this.preview()?.teamName.trim().charAt(0) || '?').toUpperCase(),
  );

  async ngOnInit(): Promise<void> {
    try {
      this.preview.set(await this.membership.preview(this.token()));
      this.state.set('ready');
    } catch {
      this.state.set('invalid'); // unknown, expired, revoked and used look the same, on purpose
    }
  }

  protected async join(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.otherAddress.set(false);
    try {
      const res = await this.membership.accept(this.token());
      await this.router.navigate(['/app/t', res.teamId]);
    } catch (e) {
      const p = toProblem(e);
      if (p.code === 'invite_other_address') this.otherAddress.set(true);
      if (p.status === 404) this.state.set('invalid');
      this.error.set(
        ['invite_other_address', 'email_not_verified', 'quota_exceeded'].includes(p.code)
          ? `invite.err.${p.code}`
          : 'errors.generic',
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl(`/invite/${this.token()}`);
  }
}
