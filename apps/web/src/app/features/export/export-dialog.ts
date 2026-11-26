import { HttpClient, type HttpResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import { collectMediaIds, docToMarkdown, EMPTY_DOC, renderPrintHtml, type ExportScope, type PrintEntry, type PrintPageSize } from '@os-planner/shared';
import { isUnreachable } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { Platform } from '../../core/platform';
import { Db } from '../../data/db';
import { MediaStore } from '../../data/media-store';
import { PageStore } from '../../data/page-store';
import { TreeStore, type CategoryNode } from '../../data/tree-store';

export interface ExportData {
  scope: ExportScope;
  id: string;
  name: string;
}

function filenameFrom(res: HttpResponse<Blob>, fallback: string): string {
  const header = res.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

@Component({
  selector: 'app-export-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatButtonToggleModule, MatCheckboxModule, MatIconModule, MatProgressSpinnerModule, MatSelectModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'export.title' | transloco }}</h2>
    <mat-dialog-content>
      <p class="muted what">{{ ('export.scope.' + data.scope) | transloco }}: <strong>{{ data.name }}</strong></p>

      <mat-button-toggle-group [(ngModel)]="format" [attr.aria-label]="'export.format' | transloco" hideSingleSelectionIndicator>
        <mat-button-toggle value="pdf"><mat-icon>picture_as_pdf</mat-icon> PDF</mat-button-toggle>
        <mat-button-toggle value="markdown"><mat-icon>markdown</mat-icon> {{ 'export.markdown' | transloco }}</mat-button-toggle>
      </mat-button-toggle-group>

      @if (format() === 'pdf') {
        <div class="opts">
          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.pageSize' | transloco }}</mat-label>
            <mat-select [(ngModel)]="pageSize">
              <mat-option value="A4">A4</mat-option>
              <mat-option value="Letter">Letter</mat-option>
            </mat-select>
          </mat-form-field>
          @if (data.scope !== 'page') { <mat-checkbox [(ngModel)]="includeToc">{{ 'export.toc' | transloco }}</mat-checkbox> }
        </div>
        <p class="hint muted">{{ 'export.pdfHint' | transloco }}</p>
      } @else {
        <p class="hint muted">{{ (data.scope === 'page' ? 'export.mdHintPage' : 'export.mdHintZip') | transloco }}</p>
      }

      @if (error()) { <p class="err">{{ error() | transloco }}</p> }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.cancel' | transloco }}</button>
      <button mat-flat-button type="button" (click)="run()" [disabled]="busy()">
        @if (busy()) { <mat-spinner diameter="18" /> } @else { <mat-icon>download</mat-icon> }
        {{ 'export.run' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .what { margin-top: 0; } .opts { display: flex; gap: 16px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
    .hint { font-size: 12px; margin: 8px 0 0; } .err { color: var(--mat-sys-error); } mat-spinner { display: inline-block; margin-right: 8px; }
  `,
})
export class ExportDialog {
  readonly data = inject<ExportData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ExportDialog>>(MatDialogRef);
  private readonly http = inject(HttpClient);
  private readonly lang = inject(Language);
  private readonly notify = inject(Notify);
  private readonly platform = inject(Platform);
  private readonly tree = inject(TreeStore);
  private readonly pages = inject(PageStore);
  private readonly media = inject(MediaStore);
  private readonly dbs = inject(Db);

  readonly format = signal<'pdf' | 'markdown'>('pdf');
  readonly busy = signal(false);
  readonly error = signal('');
  pageSize: PrintPageSize = 'A4';
  includeToc = true;

  async run(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.format() === 'pdf') await this.pdf();
      else await this.markdown();
      this.ref.close();
    } catch (e) {
      console.error('export failed', e);
      this.error.set('export.failed');
    } finally {
      this.busy.set(false);
    }
  }

  // ---------------------------------------------------------------- PDF

  private async pdf(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post('/api/export/pdf', { scope: this.data.scope, id: this.data.id, pageSize: this.pageSize, includeToc: this.includeToc, locale: this.lang.current }, { responseType: 'blob', observe: 'response' }),
      );
      await this.platform.saveBlob(res.body!, filenameFrom(res, `${this.data.name}.pdf`));
    } catch (e) {
      // No connection, or this server has no browser to render with: print from this device instead.
      const unavailable = isUnreachable(e);
      if (!unavailable) throw e;
      await this.printLocally();
      this.notify.info('export.localPrint');
    }
  }

  /** Same document, same print renderer; the browser itself turns it into a PDF ("Save as PDF" in its print dialog). */
  private async printLocally(): Promise<void> {
    const { entries, mediaIds } = await this.collect();
    const urls = new Map<string, string>();
    for (const id of mediaIds) {
      const url = await this.media.urlFor(id, 'image');
      if (url) urls.set(id, url);
    }
    const nb = this.tree.notebookById().get(this.data.id);
    const html = renderPrintHtml({
      title: this.data.name,
      subtitle: nb ? this.lang.t('export.scope.notebook') : undefined,
      entries,
      locale: this.lang.current,
      pageSize: this.pageSize,
      cover: this.data.scope !== 'page',
      includeToc: this.includeToc && this.data.scope !== 'page',
      mediaUrl: (id) => urls.get(id) ?? '',
      assetsBase: '/print/',
    });

    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = html;
    document.body.appendChild(frame);
    await new Promise<void>((resolve) => (frame.onload = () => resolve()));
    const win = frame.contentWindow as (Window & { __PRINT_READY?: boolean }) | null;
    for (let i = 0; i < 150 && win && !win.__PRINT_READY; i++) await new Promise((r) => setTimeout(r, 200));
    win?.focus();
    win?.print();
    setTimeout(() => frame.remove(), 60_000);
  }

  private async collect(): Promise<{ entries: PrintEntry[]; mediaIds: string[] }> {
    const entries: PrintEntry[] = [];
    const ids = new Set<string>();
    const docOf = async (pageId: string): Promise<JSONContent> => {
      const row = (await this.dbs.db.contents.get(pageId)) ?? (await this.pages.load(pageId));
      const doc = (row?.content ?? structuredClone(EMPTY_DOC)) as JSONContent;
      collectMediaIds(doc).forEach((m) => ids.add(m));
      return doc;
    };
    const walk = async (nodes: CategoryNode[], depth: number): Promise<void> => {
      for (const n of nodes) {
        entries.push({ kind: 'category', id: n.category.id, name: n.category.name, depth });
        for (const p of n.pages) entries.push({ kind: 'page', id: p.id, title: p.title, doc: await docOf(p.id), depth: depth + 1 });
        await walk(n.children, depth + 1);
      }
    };

    if (this.data.scope === 'page') {
      const p = this.tree.pageById().get(this.data.id);
      entries.push({ kind: 'page', id: this.data.id, title: p?.title ?? '', doc: await docOf(this.data.id), depth: 0 });
    } else if (this.data.scope === 'notebook') {
      await walk(this.tree.tree().find((n) => n.notebook.id === this.data.id)?.roots ?? [], 0);
    } else {
      const find = (nodes: CategoryNode[]): CategoryNode | undefined => {
        for (const n of nodes) {
          if (n.category.id === this.data.id) return n;
          const inner = find(n.children);
          if (inner) return inner;
        }
        return undefined;
      };
      const node = this.tree.tree().map((n) => find(n.roots)).find(Boolean);
      if (node) await walk([node], 0);
    }
    return { entries, mediaIds: [...ids] };
  }

  // ---------------------------------------------------------------- Markdown

  private async markdown(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get('/api/export/markdown', { params: { scope: this.data.scope, id: this.data.id }, responseType: 'blob', observe: 'response' }),
      );
      await this.platform.saveBlob(res.body!, filenameFrom(res, `${this.data.name}.md`));
    } catch (e) {
      // Offline fallback covers a single page (no images); folders and media need the server.
      if (!isUnreachable(e) || this.data.scope !== 'page') throw e;
      const doc = (await this.dbs.db.contents.get(this.data.id))?.content ?? structuredClone(EMPTY_DOC);
      const text = docToMarkdown(doc as JSONContent);
      await this.platform.saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${this.data.name || 'page'}.md`);
    }
  }
}
