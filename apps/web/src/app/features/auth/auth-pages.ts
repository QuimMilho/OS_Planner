import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AuthStore, toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';

const KNOWN_ERRORS = new Set(['invalid_credentials', 'email_taken', 'password_too_common', 'offline', 'invalid_or_expired_token', 'http_429']);
/** Maps a failed request to a translation key. */
export const errorKey = (e: unknown): string => {
  const code = toProblem(e).code;
  return KNOWN_ERRORS.has(code) ? `errors.${code}` : 'errors.generic';
};

const SHARED = [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressSpinnerModule, TranslocoPipe];

// ---------------------------------------------------------------- login

@Component({
  selector: 'app-login',
  imports: SHARED,
  template: `
    <main class="auth-page">
      <div class="auth-card">
        <a class="brand" routerLink="/"><img src="favicon.svg" alt="" />Notes</a>
        <h1>{{ 'auth.signIn' | transloco }}</h1>
        <form (ngSubmit)="submit()" #f="ngForm">
          <mat-form-field appearance="outline"><mat-label>{{ 'auth.email' | transloco }}</mat-label><input matInput type="email" name="email" [(ngModel)]="email" autocomplete="username" required /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>{{ 'auth.password' | transloco }}</mat-label><input matInput type="password" name="password" [(ngModel)]="password" autocomplete="current-password" required /></mat-form-field>
          @if (error()) { <p class="error" role="alert">{{ error() | transloco }}</p> }
          <button mat-flat-button type="submit" [disabled]="busy() || f.invalid">{{ 'auth.signIn' | transloco }}</button>
        </form>
        <p class="alt"><a routerLink="/forgot-password">{{ 'auth.forgot' | transloco }}</a></p>
        <p class="alt">{{ 'auth.noAccount' | transloco }} <a routerLink="/register">{{ 'auth.createAccount' | transloco }}</a></p>
      </div>
    </main>
  `,
})
export class Login {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  /** Where to go after signing in (set by the auth guard). */
  readonly returnUrl = input<string>();
  email = '';
  password = '';
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.email.trim(), this.password);
      const target = this.returnUrl();
      await this.router.navigateByUrl(target && target.startsWith('/app') ? target : '/app');
    } catch (e) {
      this.error.set(errorKey(e));
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------- register

@Component({
  selector: 'app-register',
  imports: SHARED,
  template: `
    <main class="auth-page">
      <div class="auth-card">
        <a class="brand" routerLink="/"><img src="favicon.svg" alt="" />Notes</a>
        <h1>{{ 'auth.createAccount' | transloco }}</h1>
        <form (ngSubmit)="submit()" #f="ngForm">
          <mat-form-field appearance="outline"><mat-label>{{ 'auth.name' | transloco }}</mat-label><input matInput name="name" [(ngModel)]="name" autocomplete="name" maxlength="80" required /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>{{ 'auth.email' | transloco }}</mat-label><input matInput type="email" name="email" [(ngModel)]="email" autocomplete="email" required /></mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>{{ 'auth.password' | transloco }}</mat-label>
            <input matInput type="password" name="password" [(ngModel)]="password" autocomplete="new-password" minlength="10" required />
            <mat-hint>{{ 'auth.passwordHint' | transloco }}</mat-hint>
          </mat-form-field>
          @if (error()) { <p class="error" role="alert">{{ error() | transloco }}</p> }
          <button mat-flat-button type="submit" [disabled]="busy() || f.invalid">{{ 'auth.createAccount' | transloco }}</button>
        </form>
        <p class="alt">{{ 'auth.haveAccount' | transloco }} <a routerLink="/login">{{ 'auth.signIn' | transloco }}</a></p>
      </div>
    </main>
  `,
})
export class Register {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly lang = inject(Language);
  name = '';
  email = '';
  password = '';
  readonly error = signal('');
  readonly busy = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.register({ email: this.email.trim(), password: this.password, displayName: this.name.trim(), locale: this.lang.current });
      await this.router.navigateByUrl('/app');
    } catch (e) {
      this.error.set(errorKey(e));
    } finally {
      this.busy.set(false);
    }
  }
}

// ---------------------------------------------------------------- email verification

@Component({
  selector: 'app-verify-email',
  imports: SHARED,
  template: `
    <main class="auth-page">
      <div class="auth-card center">
        <a class="brand" routerLink="/"><img src="favicon.svg" alt="" />Notes</a>
        @switch (state()) {
          @case ('working') { <mat-spinner diameter="36" /><p>{{ 'auth.verifying' | transloco }}</p> }
          @case ('ok') { <mat-icon class="big ok">check_circle</mat-icon><h1>{{ 'auth.verified' | transloco }}</h1><a mat-flat-button routerLink="/app">{{ 'auth.continue' | transloco }}</a> }
          @default { <mat-icon class="big bad">error</mat-icon><h1>{{ 'errors.invalid_or_expired_token' | transloco }}</h1><a mat-stroked-button routerLink="/app">{{ 'auth.continue' | transloco }}</a> }
        }
      </div>
    </main>
  `,
  styles: `.center { align-items: center; text-align: center; } .big { font-size: 56px; width: 56px; height: 56px; } .ok { color: #2f9e44; } .bad { color: var(--mat-sys-error); }`,
})
export class VerifyEmail implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthStore);
  readonly token = input<string>();
  readonly state = signal<'working' | 'ok' | 'failed'>('working');

  async ngOnInit(): Promise<void> {
    const token = this.token();
    if (!token) return void this.state.set('failed');
    try {
      await firstValueFrom(this.http.post('/api/auth/verify-email', { token }));
      this.state.set('ok');
      if (this.auth.status() === 'authed') await this.auth.refresh(); // pick up emailVerified
    } catch {
      this.state.set('failed');
    }
  }
}

// ---------------------------------------------------------------- forgot / reset password

@Component({
  selector: 'app-forgot-password',
  imports: SHARED,
  template: `
    <main class="auth-page">
      <div class="auth-card">
        <a class="brand" routerLink="/"><img src="favicon.svg" alt="" />Notes</a>
        <h1>{{ 'auth.forgotTitle' | transloco }}</h1>
        @if (sent()) {
          <p>{{ 'auth.forgotSent' | transloco }}</p>
          <a mat-stroked-button routerLink="/login">{{ 'auth.backToSignIn' | transloco }}</a>
        } @else {
          <p class="muted">{{ 'auth.forgotText' | transloco }}</p>
          <form (ngSubmit)="submit()" #f="ngForm">
            <mat-form-field appearance="outline"><mat-label>{{ 'auth.email' | transloco }}</mat-label><input matInput type="email" name="email" [(ngModel)]="email" autocomplete="email" required /></mat-form-field>
            @if (error()) { <p class="error" role="alert">{{ error() | transloco }}</p> }
            <button mat-flat-button type="submit" [disabled]="busy() || f.invalid">{{ 'auth.sendLink' | transloco }}</button>
          </form>
          <p class="alt"><a routerLink="/login">{{ 'auth.backToSignIn' | transloco }}</a></p>
        }
      </div>
    </main>
  `,
})
export class ForgotPassword {
  private readonly http = inject(HttpClient);
  email = '';
  readonly sent = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post('/api/auth/forgot-password', { email: this.email.trim() }));
      this.sent.set(true);
    } catch (e) {
      this.error.set(errorKey(e));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'app-reset-password',
  imports: SHARED,
  template: `
    <main class="auth-page">
      <div class="auth-card">
        <a class="brand" routerLink="/"><img src="favicon.svg" alt="" />Notes</a>
        <h1>{{ 'auth.resetTitle' | transloco }}</h1>
        @if (done()) {
          <p>{{ 'auth.resetDone' | transloco }}</p>
          <a mat-flat-button routerLink="/login">{{ 'auth.signIn' | transloco }}</a>
        } @else {
          <form (ngSubmit)="submit()" #f="ngForm">
            <mat-form-field appearance="outline">
              <mat-label>{{ 'settings.newPassword' | transloco }}</mat-label>
              <input matInput type="password" name="password" [(ngModel)]="password" autocomplete="new-password" minlength="10" required />
              <mat-hint>{{ 'auth.passwordHint' | transloco }}</mat-hint>
            </mat-form-field>
            @if (error()) { <p class="error" role="alert">{{ error() | transloco }}</p> }
            <button mat-flat-button type="submit" [disabled]="busy() || f.invalid || !token()">{{ 'auth.resetSubmit' | transloco }}</button>
          </form>
        }
      </div>
    </main>
  `,
})
export class ResetPassword {
  private readonly http = inject(HttpClient);
  readonly token = input<string>();
  password = '';
  readonly done = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.http.post('/api/auth/reset-password', { token: this.token(), password: this.password }));
      this.done.set(true);
    } catch (e) {
      this.error.set(errorKey(e));
    } finally {
      this.busy.set(false);
    }
  }
}
