import { Component, ElementRef, Injectable, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { loadKatex } from '../features/editor/lazy-libs';

// ---------------------------------------------------------------- confirm

export interface ConfirmData {
  titleKey: string;
  messageKey: string;
  params?: Record<string, unknown>;
  confirmKey?: string;
  danger?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ data.titleKey | transloco: data.params }}</h2>
    <mat-dialog-content>{{ data.messageKey | transloco: data.params }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false">{{ 'common.cancel' | transloco }}</button>
      <button mat-flat-button type="button" [mat-dialog-close]="true" [class.danger]="data.danger" cdkFocusInitial>{{ (data.confirmKey ?? 'common.ok') | transloco }}</button>
    </mat-dialog-actions>
  `,
  styles: `.danger { --mat-button-filled-container-color: var(--mat-sys-error); --mat-button-filled-label-text-color: var(--mat-sys-on-error); }`,
})
export class ConfirmDialog {
  readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

// ---------------------------------------------------------------- prompt

export interface PromptData {
  titleKey: string;
  labelKey: string;
  value?: string;
  placeholder?: string;
  /** Returns an error message key, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
  confirmKey?: string;
  /** Adds a second button (e.g. "Remove link") that closes with { action: 'secondary' }. */
  secondaryKey?: string;
}
export type PromptResult = { action: 'ok'; value: string } | { action: 'secondary' } | null;

@Component({
  selector: 'app-prompt-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ data.titleKey | transloco }}</h2>
    <form (ngSubmit)="submit()">
      <mat-dialog-content>
        <mat-form-field appearance="outline" class="full">
          <mat-label>{{ data.labelKey | transloco }}</mat-label>
          <input matInput name="value" [(ngModel)]="value" [placeholder]="data.placeholder ?? ''" autocomplete="off" cdkFocusInitial />
          @if (error()) { <mat-error>{{ error()! | transloco }}</mat-error> }
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        @if (data.secondaryKey) { <button mat-button type="button" (click)="ref.close({ action: 'secondary' })">{{ data.secondaryKey | transloco }}</button> }
        <button mat-button type="button" (click)="ref.close(null)">{{ 'common.cancel' | transloco }}</button>
        <button mat-flat-button type="submit">{{ (data.confirmKey ?? 'common.ok') | transloco }}</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `.full { width: min(420px, 80vw); }`,
})
export class PromptDialog {
  readonly data = inject<PromptData>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<PromptDialog, PromptResult>>(MatDialogRef);
  value = this.data.value ?? '';
  readonly error = signal<string | null>(null);

  submit(): void {
    const v = this.value.trim();
    const problem = this.data.validate?.(v) ?? null;
    this.error.set(problem);
    if (!problem) this.ref.close({ action: 'ok', value: v });
  }
}

// ---------------------------------------------------------------- math

export interface MathData {
  latex: string;
  block: boolean;
  isNew: boolean;
}
export type MathResult = { action: 'save'; latex: string } | { action: 'delete' } | null;

@Component({
  selector: 'app-math-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ (data.block ? 'editor.mathBlock' : 'editor.mathInline') | transloco }}</h2>
    <mat-dialog-content>
      <textarea class="src" rows="4" spellcheck="false" [(ngModel)]="latex" (ngModelChange)="render()" [placeholder]="'editor.mathPlaceholder' | transloco" cdkFocusInitial></textarea>
      <div class="preview" #preview></div>
      @if (error()) { <p class="err">{{ error() }}</p> }
      <p class="hint muted">{{ 'editor.mathHint' | transloco }} <a href="https://katex.org/docs/supported.html" target="_blank" rel="noopener noreferrer">KaTeX</a></p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!data.isNew) { <button mat-button type="button" (click)="ref.close({ action: 'delete' })">{{ 'common.delete' | transloco }}</button> }
      <button mat-button type="button" (click)="ref.close(null)">{{ 'common.cancel' | transloco }}</button>
      <button mat-flat-button type="button" [disabled]="!latex.trim()" (click)="ref.close({ action: 'save', latex: latex.trim() })">{{ 'common.save' | transloco }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .src { width: min(560px, 80vw); font: 14px/1.5 'Cascadia Mono', Consolas, monospace; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); resize: vertical; }
    .preview { min-height: 56px; display: grid; place-items: center; margin: 12px 0 4px; overflow-x: auto; font-size: 1.2em; }
    .err { color: var(--mat-sys-error); font-size: 12px; margin: 0; } .hint { font-size: 12px; margin: 8px 0 0; }
  `,
})
export class MathDialog {
  readonly data = inject<MathData>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<MathDialog, MathResult>>(MatDialogRef);
  latex = this.data.latex;
  readonly error = signal('');
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');

  constructor() {
    effect(() => {
      if (this.preview()) void this.render();
    });
  }

  async render(): Promise<void> {
    const el = this.preview()?.nativeElement;
    if (!el) return;
    const katex = await loadKatex();
    try {
      katex.render(this.latex, el, { displayMode: this.data.block, throwOnError: true });
      this.error.set('');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message.replace(/^KaTeX parse error: /, '') : String(e));
    }
  }
}

// ---------------------------------------------------------------- helpers

/** Thin wrappers so features can ask questions in one line. */
@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly dialog = inject(MatDialog);

  confirm(data: ConfirmData): Promise<boolean> {
    return firstValueFrom(this.dialog.open<ConfirmDialog, ConfirmData, boolean>(ConfirmDialog, { data, autoFocus: 'dialog' }).afterClosed()).then(Boolean);
  }

  prompt(data: PromptData): Promise<PromptResult> {
    return firstValueFrom(this.dialog.open<PromptDialog, PromptData, PromptResult>(PromptDialog, { data }).afterClosed()).then((r) => r ?? null);
  }

  math(data: MathData): Promise<MathResult> {
    return firstValueFrom(this.dialog.open<MathDialog, MathData, MathResult>(MathDialog, { data }).afterClosed()).then((r) => r ?? null);
  }
}
