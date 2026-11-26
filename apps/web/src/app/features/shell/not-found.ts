import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';

/** Shown for addresses that do not exist or that the person may not see: both look the same on purpose. */
@Component({
  selector: 'app-not-found',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="nf" role="alert">
      <mat-icon aria-hidden="true">search_off</mat-icon>
      <h1>{{ 'errors.notFoundTitle' | transloco }}</h1>
      <p class="muted">{{ 'errors.notFound' | transloco }}</p>
      <a mat-flat-button routerLink="/app">{{ 'errors.backHome' | transloco }}</a>
    </div>
  `,
  styles: `
    .nf {
      max-width: 420px;
      margin: 0 auto;
      padding: 96px 20px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    mat-icon {
      font-size: 56px;
      width: 56px;
      height: 56px;
      color: var(--text-dim);
    }
    h1 {
      margin: 0;
    }
    p {
      margin: 0 0 8px;
    }
  `,
})
export class NotFoundPage {}
