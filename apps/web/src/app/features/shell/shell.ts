import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatBadgeModule } from '@angular/material/badge';
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
import { RealtimeService } from '../../core/realtime';
import { QuotaStore } from '../../core/quota';
import { Session } from '../../core/session';
import { CalendarStore } from '../../data/calendar-store';
import { ChatStore } from '../../data/chat-store';
import { HistoryStore } from '../../data/history-store';
import { TreeStore } from '../../data/tree-store';
import { Sync } from '../../data/sync';
import { Dialogs } from '../../shared/dialogs';
import { NavContext } from '../../core/nav-context';
import { DmSidebar } from '../dm/dm-pages';
import { Bell } from '../notifications/inbox';
import { TeamSidebar } from '../team/team-sidebar';
import { Breadcrumb } from './breadcrumb';
import { Rail } from './rail';
import { BoardList } from '../boards/board-list';
import { Tree } from './tree';
import { Features } from '../../data/features';
import { VoiceBar } from '../voice/voice-bar';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, MatSidenavModule, MatBadgeModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, Tree, BoardList, TeamSidebar, DmSidebar, Bell, Breadcrumb, Rail, VoiceBar, TranslocoPipe],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  readonly auth = inject(AuthStore);
  readonly sync = inject(Sync);
  readonly online = inject(Online);
  readonly platform = inject(Platform);
  readonly quota = inject(QuotaStore);
  readonly nav = inject(NavContext);
  readonly treeStore = inject(TreeStore);
  readonly realtime = inject(RealtimeService);
  readonly calendar = inject(CalendarStore);
  readonly features = inject(Features);
  /** What waits for a decision in the Local history (the badge on the History button). */
  readonly history = inject(HistoryStore);
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

  private readonly chat = inject(ChatStore);

  constructor() {
    void this.quota.refresh();
    // The channels of the team on screen are kept fresh and listened to.
    effect(() => this.chat.setActiveTeam(this.nav.teamId()));
  }

  /** On the page of the call itself the call bar would only repeat its controls. */
  readonly onVoicePage = computed(() => this.nav.url().startsWith('/app/v/'));

  readonly lastIssue = computed(() => this.sync.issues().at(-1) ?? null);
  readonly initial = computed(() => (this.auth.user()?.displayName ?? '?').trim().charAt(0).toUpperCase());

  /** The live connection: shown only while it is not fine, so a quiet top bar means everything is current. */
  readonly connection = computed(() => (this.auth.status() === 'authed' ? this.realtime.status() : 'offline'));

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
