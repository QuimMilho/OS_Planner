import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, map } from 'rxjs';
import { AuthStore } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { Platform } from '../../core/platform';
import { Session } from '../../core/session';
import { Sync } from '../../data/sync';
import { Dialogs } from '../../shared/dialogs';
import { Tree } from './tree';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, MatSidenavModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, Tree, TranslocoPipe],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  readonly auth = inject(AuthStore);
  readonly sync = inject(Sync);
  readonly online = inject(Online);
  readonly platform = inject(Platform);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);
  private readonly session = inject(Session);

  readonly isMobile = toSignal(inject(BreakpointObserver).observe('(max-width: 860px)').pipe(map((r) => r.matches)), { initialValue: false });
  private readonly manualOpen = signal<boolean | null>(null);
  /** Open on wide screens, closed on phones, until the person toggles it. */
  readonly sidenavOpen = computed(() => this.manualOpen() ?? !this.isMobile());
  query = '';

  readonly lastIssue = computed(() => this.sync.issues().at(-1) ?? null);
  readonly initial = computed(() => (this.auth.user()?.displayName ?? '?').trim().charAt(0).toUpperCase());

  readonly status = computed(() => {
    if (!this.online.isOnline() || this.auth.offlineSession() || this.sync.state() === 'offline') return 'offline';
    if (this.sync.state() === 'error') return 'error';
    return this.sync.state() === 'syncing' || this.sync.pending() > 0 ? 'syncing' : 'idle';
  });

  toggleSidenav(): void {
    this.manualOpen.set(!this.sidenavOpen());
  }

  /** On phones the drawer covers the page, so close it after navigating. */
  onNavigate(): void {
    if (this.isMobile()) this.manualOpen.set(false);
  }

  search(): void {
    const q = this.query.trim();
    void this.router.navigate(['/app/search'], { queryParams: q ? { q } : {} });
    this.onNavigate();
  }

  async resendVerification(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/resend-verification', {}));
      this.notify.info('auth.verifySent');
    } catch {
      this.notify.error('common.offlineAction');
    }
  }

  openIssue(): void {
    const issue = this.lastIssue();
    if (!issue) return;
    if (issue.pageId) void this.router.navigate(['/app/p', issue.pageId]);
    this.sync.dismissIssue(issue.id);
  }

  async signOut(): Promise<void> {
    // Signing out removes the notes stored on this device, so warn if some have not reached the server yet.
    if (this.sync.pending() > 0 && !(await this.dialogs.confirm({ titleKey: 'settings.signOutTitle', messageKey: 'settings.unsyncedWarning', confirmKey: 'nav.signOut', danger: true }))) return;
    await this.session.signOut();
    await this.router.navigate(['/']);
  }
}
