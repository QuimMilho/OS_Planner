import { Component, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent, TiptapNodeViewContentDirective } from 'ngx-tiptap';
import { CALLOUT_VARIANTS } from '@os-planner/shared';

const ICONS: Record<string, string> = { info: 'info', tip: 'lightbulb', warning: 'warning', danger: 'error' };

@Component({
  selector: 'app-callout-view',
  imports: [MatIconModule, TranslocoPipe, TiptapNodeViewContentDirective],
  host: { class: 'node-view' },
  template: `
    <div class="callout" [attr.data-variant]="variant()">
      <div class="side" contenteditable="false">
        <mat-icon class="ic">{{ icon[variant()] }}</mat-icon>
        @if (selected() || selectionInside()) {
          <div class="variants">
            @for (v of variants; track v) {
              <button type="button" [class.on]="v === variant()" [attr.data-variant]="v" (click)="set(v)" [attr.aria-label]="'editor.callout.' + v | transloco"><mat-icon>{{ icon[v] }}</mat-icon></button>
            }
          </div>
        }
      </div>
      <div class="body" tiptapNodeViewContent></div>
    </div>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .callout { display: flex; gap: 10px; border-left: 4px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border-radius: 8px; padding: 8px 12px; }
    .callout[data-variant='tip'] { --accent: #2f9e44; } .callout[data-variant='warning'] { --accent: #f08c00; } .callout[data-variant='danger'] { --accent: #e03131; }
    .side { display: flex; flex-direction: column; align-items: center; gap: 4px; user-select: none; } .ic { color: var(--accent); margin-top: 2px; }
    .variants { display: flex; flex-direction: column; gap: 2px; } .variants button { border: 0; background: none; cursor: pointer; padding: 0; border-radius: 50%; opacity: 0.45; display: grid; place-items: center; }
    .variants button.on, .variants button:hover { opacity: 1; } .variants mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .variants [data-variant='info'] { color: #3b5bdb; } .variants [data-variant='tip'] { color: #2f9e44; } .variants [data-variant='warning'] { color: #f08c00; } .variants [data-variant='danger'] { color: #e03131; }
    .body { flex: 1; min-width: 0; }
  `,
})
export class CalloutView extends AngularNodeViewComponent {
  readonly variants = CALLOUT_VARIANTS;
  readonly icon = ICONS;
  readonly variant = computed(() => String(this.node().attrs['variant'] ?? 'info'));

  set(variant: string): void {
    this.updateAttributes()({ variant });
  }
}
