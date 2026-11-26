import { HttpClient } from '@angular/common/http';
import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { DownloadsDto, ReleaseFile, ReleaseFormat, ReleaseManifest } from '@os-planner/shared';
import { apiUrl } from '../../core/api-config';
import { Language } from '../../core/i18n';
import { InstallPrompt, Platform } from '../../core/platform';

const FORMAT_LABEL: Record<ReleaseFormat, string> = { nsis: 'Installer (.exe)', portable: 'Portable (.exe)', appimage: 'AppImage', deb: 'Debian / Ubuntu (.deb)', rpm: 'Fedora / RHEL (.rpm)' };
const FORMAT_HINT: Partial<Record<ReleaseFormat, string>> = {
  appimage: 'chmod +x OS_Planner-*.AppImage && ./OS_Planner-*.AppImage',
  deb: 'sudo apt install ./OS_Planner-*.deb',
  rpm: 'sudo dnf install ./OS_Planner-*.rpm',
};

/** Everything about getting the app: use it in the browser, install it as a PWA, or download the desktop build. */
@Component({
  selector: 'app-apps-panel',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <section class="card">
      <h2><mat-icon>language</mat-icon>{{ 'apps.browser' | transloco }}</h2>
      <p class="muted">{{ 'apps.browserText' | transloco }}</p>
      @if (showOpen()) { <a mat-stroked-button routerLink="/app"><mat-icon>open_in_new</mat-icon>{{ 'apps.openBrowser' | transloco }}</a> }
    </section>

    <section class="card">
      <h2><mat-icon>install_mobile</mat-icon>{{ 'apps.pwa' | transloco }}</h2>
      <p class="muted">{{ 'apps.pwaText' | transloco }}</p>
      @if (platform.mode !== 'browser') {
        <p class="ok"><mat-icon>check_circle</mat-icon>{{ 'apps.alreadyInstalled' | transloco }}</p>
      } @else if (install.canInstall()) {
        <button mat-flat-button type="button" (click)="install.install()"><mat-icon>download</mat-icon>{{ 'apps.installNow' | transloco }}</button>
      } @else if (install.installed()) {
        <p class="ok"><mat-icon>check_circle</mat-icon>{{ 'apps.justInstalled' | transloco }}</p>
      } @else {
        <p class="how">{{ ('apps.how.' + platform.os) | transloco }}</p>
      }
    </section>

    <section class="card">
      <h2><mat-icon>desktop_windows</mat-icon>{{ 'apps.desktop' | transloco }}</h2>
      <p class="muted">{{ 'apps.desktopText' | transloco }}</p>
      @if (loading()) {
        <p class="muted">{{ 'common.loading' | transloco }}</p>
      } @else if (!release()) {
        <p class="muted">{{ 'apps.noRelease' | transloco }}</p>
      } @else {
        @if (primary(); as p) {
          <a mat-flat-button [href]="downloadUrl(p.name)" download>
            <mat-icon>download</mat-icon>{{ 'apps.downloadFor' | transloco: { os: platform.os === 'windows' ? 'Windows' : 'Linux' } }} · {{ release()!.version }}
          </a>
          <p class="meta muted">{{ label(p) }} · {{ size(p.size) }}</p>
        } @else if (platform.os === 'mac' || platform.os === 'ios' || platform.os === 'android') {
          <p class="muted">{{ 'apps.noDesktopForOs' | transloco }}</p>
        }
        @if (release()!.notes) { <p class="notes">{{ release()!.notes }}</p> }

        <h3>{{ 'apps.allBuilds' | transloco }} <span class="muted">v{{ release()!.version }} · {{ lang.date(release()!.releasedAt) }}</span></h3>
        <div class="table">
          @for (f of release()!.files; track f.name) {
            <div class="row">
              <div class="what">
                <strong>{{ f.os === 'windows' ? 'Windows' : 'Linux' }} · {{ f.arch }}</strong>
                <span class="muted">{{ label(f) }} · {{ size(f.size) }}</span>
                @if (hint(f); as h) { <code>{{ h }}</code> }
                <span class="sha muted" [title]="f.sha256">SHA-256: {{ f.sha256.slice(0, 16) }}…</span>
              </div>
              <a mat-stroked-button [href]="downloadUrl(f.name)" download>{{ 'apps.download' | transloco }}</a>
            </div>
          }
        </div>
        @if (hasWindows()) { <p class="smartscreen muted"><mat-icon>shield</mat-icon>{{ 'apps.smartscreen' | transloco }}</p> }
      }
    </section>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 16px; }
    .card { border: 1px solid var(--border); border-radius: 16px; padding: 20px 24px; background: var(--surface); }
    h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 18px; } h2 mat-icon { color: var(--accent); } h3 { margin: 20px 0 8px; font-size: 14px; }
    p { margin: 0 0 12px; } .ok { display: flex; align-items: center; gap: 8px; color: #2f9e44; } .meta { font-size: 13px; margin-top: 8px; } .notes { white-space: pre-wrap; margin-top: 12px; }
    .how { padding: 10px 14px; background: var(--surface-3); border-radius: 10px; } .table { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; }
    .row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); } .row:last-child { border-bottom: 0; } .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    code { background: var(--surface-3); padding: 2px 6px; border-radius: 6px; font-size: 12px; overflow-x: auto; white-space: nowrap; } .sha { font-size: 11px; }
    .smartscreen { display: flex; gap: 8px; align-items: center; font-size: 13px; margin: 12px 0 0; }
  `,
})
export class AppsPanel implements OnInit {
  readonly showOpen = input(false);
  readonly platform = inject(Platform);
  readonly install = inject(InstallPrompt);
  readonly lang = inject(Language);
  private readonly http = inject(HttpClient);

  readonly release = signal<ReleaseManifest | null>(null);
  readonly loading = signal(true);
  readonly hasWindows = computed(() => !!this.release()?.files.some((f) => f.os === 'windows'));

  /** The build for this computer: the installer on Windows, the AppImage (runs anywhere) on Linux. */
  readonly primary = computed(() => {
    const files = this.release()?.files ?? [];
    const os = this.platform.os;
    if (os === 'windows') return files.find((f) => f.os === 'windows' && f.format === 'nsis') ?? files.find((f) => f.os === 'windows');
    if (os === 'linux') return files.find((f) => f.os === 'linux' && f.format === 'appimage') ?? files.find((f) => f.os === 'linux');
    return undefined;
  });

  async ngOnInit(): Promise<void> {
    try {
      this.release.set((await firstValueFrom(this.http.get<DownloadsDto>('/api/downloads'))).release);
    } catch {
      /* offline: the panel simply shows no builds */
    } finally {
      this.loading.set(false);
    }
  }

  downloadUrl(name: string): string {
    return apiUrl(`/downloads/${encodeURIComponent(name)}`);
  }
  label(f: ReleaseFile): string {
    return FORMAT_LABEL[f.format];
  }
  hint(f: ReleaseFile): string | undefined {
    return FORMAT_HINT[f.format];
  }
  size(bytes: number): string {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
}
