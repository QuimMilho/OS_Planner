import { Component, computed, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent, TiptapNodeViewContentDirective } from 'ngx-tiptap';

export const CODE_LANGUAGES = [
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql', 'java', 'javascript', 'json', 'kotlin', 'lua',
  'makefile', 'markdown', 'objectivec', 'perl', 'php', 'python', 'r', 'ruby', 'rust', 'scss', 'shell', 'sql',
  'swift', 'typescript', 'vbnet', 'wasm', 'xml', 'yaml',
];

@Component({
  selector: 'app-code-block-view',
  imports: [MatIconModule, TranslocoPipe, TiptapNodeViewContentDirective],
  host: { class: 'node-view' },
  template: `
    <div class="wrap">
      <div class="head" contenteditable="false">
        <select [value]="language()" (change)="set($any($event.target).value)" [attr.aria-label]="'editor.codeLanguage' | transloco">
          <option value="">{{ 'editor.plainText' | transloco }}</option>
          @for (l of languages; track l) { <option [value]="l">{{ l }}</option> }
        </select>
        <button type="button" (click)="copy()" [attr.aria-label]="'editor.copy' | transloco">
          <mat-icon>{{ copied() ? 'check' : 'content_copy' }}</mat-icon>
        </button>
      </div>
      <pre><code tiptapNodeViewContent [class]="'language-' + language()"></code></pre>
    </div>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .wrap { position: relative; } pre { margin: 0 !important; padding-top: 30px !important; } code { white-space: pre; }
    .head { position: absolute; top: 4px; right: 8px; display: flex; gap: 4px; align-items: center; z-index: 1; opacity: 0.55; transition: opacity 0.15s; }
    .wrap:hover .head, .head:focus-within { opacity: 1; }
    select { border: 0; background: var(--surface); color: var(--text-dim); border-radius: 6px; padding: 1px 4px; font-size: 12px; }
    button { border: 0; background: none; cursor: pointer; color: var(--text-dim); display: grid; place-items: center; padding: 0; }
    button mat-icon { font-size: 16px; width: 16px; height: 16px; }
  `,
})
export class CodeBlockView extends AngularNodeViewComponent {
  readonly languages = CODE_LANGUAGES;
  readonly language = computed(() => String(this.node().attrs['language'] ?? ''));
  readonly copied = signal(false);

  set(language: string): void {
    this.updateAttributes()({ language: language || null });
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.node().textContent);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context): nothing to do */
    }
  }
}
