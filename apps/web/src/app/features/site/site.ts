import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { AuthStore } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { AppsPanel } from './apps-panel';

@Component({
  selector: 'app-site-header',
  imports: [RouterLink, MatButtonModule, TranslocoPipe],
  template: `
    <header class="bar">
      <a routerLink="/" class="brand"><img src="favicon.svg" alt="" width="30" height="30" />OS_Planner</a>
      <span class="grow"></span>
      <a mat-button routerLink="/download">{{ 'nav.getApp' | transloco }}</a>
      <button mat-button type="button" (click)="toggleLang()" [attr.aria-label]="'settings.language' | transloco">{{ lang.current === 'en' ? 'PT' : 'EN' }}</button>
      @if (auth.status() === 'authed') {
        <a mat-flat-button routerLink="/app">{{ 'site.openApp' | transloco }}</a>
      } @else {
        <a mat-button routerLink="/login">{{ 'auth.signIn' | transloco }}</a>
        <a mat-flat-button routerLink="/register">{{ 'site.getStarted' | transloco }}</a>
      }
    </header>
  `,
  styles: `
    .bar { display: flex; align-items: center; gap: 8px; padding: 12px 24px; max-width: 1100px; margin: 0 auto; } .grow { flex: 1; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; color: var(--text); text-decoration: none; }
    @media (max-width: 640px) { .bar { padding: 8px 12px; flex-wrap: wrap; } }
  `,
})
export class SiteHeader {
  readonly auth = inject(AuthStore);
  readonly lang = inject(Language);

  toggleLang(): void {
    const next = this.lang.current === 'en' ? 'pt' : 'en';
    this.lang.set(next);
    if (this.auth.user()) void this.auth.updateProfile({ locale: next });
  }
}

const FEATURES = [
  { icon: 'folder_copy', key: 'organise' },
  { icon: 'edit_note', key: 'editor' },
  { icon: 'functions', key: 'math' },
  { icon: 'insert_chart', key: 'charts' },
  { icon: 'perm_media', key: 'media' },
  { icon: 'picture_as_pdf', key: 'pdf' },
  { icon: 'cloud_off', key: 'offline' },
  { icon: 'devices', key: 'everywhere' },
];

@Component({
  selector: 'app-landing',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslocoPipe, SiteHeader],
  template: `
    <app-site-header />
    <main>
      <section class="hero">
        <h1>{{ 'site.heroTitle' | transloco }}</h1>
        <p class="lead">{{ 'site.heroText' | transloco }}</p>
        <div class="cta">
          @if (auth.status() === 'authed') {
            <a mat-flat-button routerLink="/app"><mat-icon>arrow_forward</mat-icon>{{ 'site.openApp' | transloco }}</a>
          } @else {
            <a mat-flat-button routerLink="/register">{{ 'site.getStarted' | transloco }}</a>
            <a mat-stroked-button routerLink="/login">{{ 'auth.signIn' | transloco }}</a>
          }
          <a mat-button routerLink="/download"><mat-icon>install_desktop</mat-icon>{{ 'nav.getApp' | transloco }}</a>
        </div>
      </section>
      <section class="features" [attr.aria-label]="'site.features' | transloco">
        @for (f of features; track f.key) {
          <article>
            <mat-icon>{{ f.icon }}</mat-icon>
            <h3>{{ 'site.f.' + f.key + '.title' | transloco }}</h3>
            <p class="muted">{{ 'site.f.' + f.key + '.text' | transloco }}</p>
          </article>
        }
      </section>
    </main>
    <footer>{{ 'site.footer' | transloco }}</footer>
  `,
  styles: `
    :host { display: block; min-height: 100%; background: linear-gradient(180deg, var(--surface-2), var(--surface) 480px); }
    main { max-width: 1100px; margin: 0 auto; padding: 0 24px; } .hero { text-align: center; padding: 72px 0 56px; }
    h1 { font-size: clamp(32px, 6vw, 56px); line-height: 1.1; margin: 0 auto 16px; max-width: 800px; letter-spacing: -0.02em; } .lead { font-size: 19px; max-width: 620px; margin: 0 auto 28px; color: var(--text-dim); }
    .cta { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; } .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; padding-bottom: 64px; }
    article { border: 1px solid var(--border); border-radius: 16px; padding: 20px; background: var(--surface); } article mat-icon { color: var(--accent); font-size: 28px; width: 28px; height: 28px; } article h3 { margin: 8px 0 4px; } article p { margin: 0; }
    footer { text-align: center; padding: 24px; color: var(--text-dim); font-size: 13px; border-top: 1px solid var(--border); }
  `,
})
export class Landing {
  readonly auth = inject(AuthStore);
  readonly features = FEATURES;
}

@Component({
  selector: 'app-download',
  imports: [TranslocoPipe, SiteHeader, AppsPanel],
  template: `
    <app-site-header />
    <main>
      <h1>{{ 'nav.getApp' | transloco }}</h1>
      <p class="muted lead">{{ 'apps.intro' | transloco }}</p>
      <app-apps-panel [showOpen]="true" />
    </main>
  `,
  styles: `
    :host { display: block; min-height: 100%; background: var(--surface-2); } main { max-width: 820px; margin: 0 auto; padding: 24px 20px 64px; } h1 { margin: 16px 0 4px; font-size: 34px; } .lead { margin: 0 0 24px; }
  `,
})
export class Download {}
