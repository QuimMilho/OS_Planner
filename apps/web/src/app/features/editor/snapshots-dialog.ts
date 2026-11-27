import { HttpClient } from '@angular/common/http';
import { Component, Injector, OnDestroy, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Editor, type JSONContent } from '@tiptap/core';
import { TiptapEditorDirective } from 'ngx-tiptap';
import { firstValueFrom } from 'rxjs';
import type { PageSnapshotDto } from '@os-planner/shared';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { buildReaderExtensions } from './editor-extensions';

export interface SnapshotsData {
  pageId: string;
}

/**
 * Earlier versions of a page (taken when somebody's session ended, every hour while people work, and before a restore).
 * Looking at one changes nothing; restoring one is a new change on top of the page as it is now, which everybody in the
 * page sees, and the page as it was is kept as a version first.
 */
@Component({
  selector: 'app-snapshots-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TiptapEditorDirective, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'collab.snapshots.title' | transloco }}</h2>
    <mat-dialog-content>
      <div class="cols">
        <ul class="list" role="listbox" [attr.aria-label]="'collab.snapshots.title' | transloco">
          @for (s of snapshots(); track s.id) {
            <li>
              <button
                type="button"
                role="option"
                [class.on]="s.id === selected()?.id"
                [attr.aria-selected]="s.id === selected()?.id"
                (click)="select(s)"
              >
                <span class="when">{{ lang.date(s.createdAt) }}</span>
                <span class="why"
                  >{{ 'collab.snapshots.reason.' + s.reason | transloco }}
                  @if (s.byName) {
                    · {{ s.byName }}
                  }
                </span>
              </button>
            </li>
          } @empty {
            <li class="muted">
              {{ (loading() ? 'common.loading' : 'collab.snapshots.none') | transloco }}
            </li>
          }
        </ul>
        <div class="preview">
          @if (preview(); as ed) {
            <div tiptap [editor]="ed" class="content"></div>
          } @else {
            <p class="muted">{{ 'collab.snapshots.pick' | transloco }}</p>
          }
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.close' | transloco }}</button>
      <button mat-flat-button type="button" (click)="restore()" [disabled]="!selected() || busy()">
        <mat-icon>restore</mat-icon>{{ 'collab.snapshots.restore' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .cols {
      display: grid;
      grid-template-columns: 220px 1fr;
      gap: 16px;
      min-height: 280px;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow: auto;
      max-height: 55vh;
    }
    .list button {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      width: 100%;
      text-align: left;
      border: 0;
      background: none;
      color: inherit;
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
      font: inherit;
    }
    .list button:hover,
    .list button.on {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .when {
      font-size: 13px;
    }
    .why {
      font-size: 12px;
      color: var(--text-dim);
    }
    .preview {
      overflow: auto;
      max-height: 55vh;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
    }
    @media (max-width: 560px) {
      .cols {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class SnapshotsDialog implements OnDestroy {
  readonly data = inject<SnapshotsData>(MAT_DIALOG_DATA);
  readonly lang = inject(Language);
  private readonly ref = inject<MatDialogRef<SnapshotsDialog>>(MatDialogRef);
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  private readonly notify = inject(Notify);

  readonly snapshots = signal<PageSnapshotDto[]>([]);
  readonly loading = signal(true);
  readonly selected = signal<PageSnapshotDto | null>(null);
  readonly preview = signal<Editor | null>(null);
  readonly busy = signal(false);

  constructor() {
    void this.load();
  }

  ngOnDestroy(): void {
    this.preview()?.destroy();
  }

  private async load(): Promise<void> {
    try {
      this.snapshots.set(
        await firstValueFrom(
          this.http.get<PageSnapshotDto[]>(`/api/pages/${this.data.pageId}/snapshots`),
        ),
      );
    } catch {
      this.notify.error('collab.snapshots.failed');
    } finally {
      this.loading.set(false);
    }
  }

  async select(s: PageSnapshotDto): Promise<void> {
    this.selected.set(s);
    try {
      const { content } = await firstValueFrom(
        this.http.get<{ content: JSONContent }>(`/api/pages/${this.data.pageId}/snapshots/${s.id}`),
      );
      this.preview()?.destroy();
      this.preview.set(
        new Editor({ extensions: buildReaderExtensions(this.injector), content, editable: false, editorProps: { attributes: { 'aria-label': this.lang.t('editor.document'), 'aria-readonly': 'true' } } }),
      );
    } catch {
      this.notify.error('collab.snapshots.failed');
    }
  }

  async restore(): Promise<void> {
    const s = this.selected();
    if (!s) return;
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.http.post(`/api/pages/${this.data.pageId}/snapshots/${s.id}/restore`, {}),
      );
      this.notify.info('collab.snapshots.restored');
      this.ref.close(true);
    } catch {
      this.notify.error('collab.snapshots.failed');
    } finally {
      this.busy.set(false);
    }
  }
}
