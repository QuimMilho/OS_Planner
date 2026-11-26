import { Component, ElementRef, OnDestroy, computed, effect, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { LIMITS, plotSpecSchema, renderPlotSvg, SERIES_PALETTE, type PlotExpression, type PlotSpec } from '@os-planner/shared';

const num = (v: string, fallback: number): number => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

@Component({
  selector: 'app-plot-view',
  imports: [FormsModule, MatIconModule, MatButtonModule, TranslocoPipe],
  host: { class: 'node-view' },
  template: `
    <div class="box" [class.selected]="selected()">
      <div class="plot" #plot></div>
      @if (renderError()) { <pre class="err">{{ renderError() }}</pre> }
      @if (selected()) {
        <div class="editor" contenteditable="false">
          @for (e of spec().expressions; track $index; let i = $index) {
            <div class="expr">
              <select [ngModel]="e.kind" (ngModelChange)="setKind(i, $event)">
                <option value="linear">y = f(x)</option>
                <option value="parametric">x(t), y(t)</option>
                <option value="polar">r(θ)</option>
              </select>
              @switch (e.kind) {
                @case ('linear') { <input class="f" spellcheck="false" [ngModel]="e.fn" (ngModelChange)="setField(i, 'fn', $event)" placeholder="sin(x)/x" /> }
                @case ('parametric') {
                  <input class="f" spellcheck="false" [ngModel]="e.x" (ngModelChange)="setField(i, 'x', $event)" placeholder="cos(t)" />
                  <input class="f" spellcheck="false" [ngModel]="e.y" (ngModelChange)="setField(i, 'y', $event)" placeholder="sin(t)" />
                }
                @case ('polar') { <input class="f" spellcheck="false" [ngModel]="e.r" (ngModelChange)="setField(i, 'r', $event)" placeholder="2*sin(3*theta)" /> }
              }
              <input type="color" [ngModel]="e.color ?? palette[i % palette.length]" (ngModelChange)="setColor(i, $event)" [attr.aria-label]="'editor.color' | transloco" />
              @if (spec().expressions.length > 1) { <button type="button" class="x" (click)="remove(i)" [attr.aria-label]="'common.delete' | transloco">×</button> }
            </div>
          }
          @if (problem()) { <p class="problem">{{ problem() }}</p> }
          <div class="row">
            <button mat-stroked-button type="button" (click)="add()" [disabled]="spec().expressions.length >= maxExpressions"><mat-icon>add</mat-icon>{{ 'editor.addExpression' | transloco }}</button>
            <label>x <input class="n" [ngModel]="spec().xDomain[0]" (ngModelChange)="setDomain('x', 0, $event)" /> … <input class="n" [ngModel]="spec().xDomain[1]" (ngModelChange)="setDomain('x', 1, $event)" /></label>
            <label>y <input class="n" [ngModel]="spec().yDomain?.[0] ?? ''" (ngModelChange)="setDomain('y', 0, $event)" placeholder="auto" /> … <input class="n" [ngModel]="spec().yDomain?.[1] ?? ''" (ngModelChange)="setDomain('y', 1, $event)" placeholder="auto" /></label>
            <label class="chk"><input type="checkbox" [ngModel]="spec().grid" (ngModelChange)="commit({ ...spec(), grid: $event })" /> {{ 'editor.grid' | transloco }}</label>
            <label class="grow">{{ 'editor.chartTitle' | transloco }} <input [ngModel]="spec().title ?? ''" (ngModelChange)="commit({ ...spec(), title: $event })" /></label>
          </div>
          <p class="hint muted">{{ 'editor.plotHint' | transloco }}</p>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .box { border: 1px solid transparent; border-radius: 10px; padding: 8px; text-align: center; } .selected { border-color: var(--accent); }
    .plot { overflow-x: auto; min-height: 60px; }
    .err { white-space: pre-wrap; color: var(--mat-sys-error); font-size: 12px; text-align: left; }
    .editor { text-align: left; margin-top: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
    .expr { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; } .f { flex: 1; min-width: 120px; font-family: 'Cascadia Mono', Consolas, monospace; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; } .grow { flex: 1; min-width: 140px; } label { display: flex; gap: 6px; align-items: center; color: var(--text-dim); }
    input:not([type='checkbox']):not([type='color']), select { border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; background: var(--surface-2); color: var(--text); font: inherit; }
    input.n { width: 64px; } input[type='color'] { width: 28px; height: 28px; padding: 0; border: 0; background: none; }
    .x { border: 0; background: none; color: var(--text-dim); cursor: pointer; font-size: 16px; } .problem { color: var(--mat-sys-error); margin: 0; } .hint { margin: 0; font-size: 12px; }
  `,
})
export class PlotView extends AngularNodeViewComponent implements OnDestroy {
  readonly palette = SERIES_PALETTE;
  readonly maxExpressions = LIMITS.plotMaxExpressions;
  readonly spec = computed(() => this.node().attrs as unknown as PlotSpec);
  readonly problem = signal('');
  readonly renderError = signal('');
  private readonly plot = viewChild<ElementRef<HTMLElement>>('plot');
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    effect((onCleanup) => {
      const el = this.plot()?.nativeElement;
      const spec = this.spec();
      if (!el) return;
      this.timer = setTimeout(() => untracked(() => this.draw(el, spec)), 120);
      onCleanup(() => this.timer && clearTimeout(this.timer));
    });
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private draw(el: HTMLElement, spec: PlotSpec): void {
    try {
      const { svg, errors } = renderPlotSvg(spec, { width: Math.min(el.clientWidth || 640, 760) });
      el.innerHTML = svg; // built by renderPlotSvg from numbers and escaped text only
      this.renderError.set(errors.join('\n'));
    } catch (e) {
      console.warn('plot render failed', e);
      this.renderError.set(e instanceof Error ? e.message : String(e));
    }
  }

  /** Only a valid plot is ever stored, so the document can always be saved. */
  commit(next: PlotSpec): void {
    const result = plotSpecSchema.safeParse({ ...next, title: next.title || undefined });
    if (!result.success) {
      const issue = result.error.issues[0]!;
      this.problem.set(`${issue.path.join('.')}: ${issue.message}`);
      return;
    }
    this.problem.set('');
    this.updateAttributes()({ ...result.data, yDomain: result.data.yDomain ?? null, title: result.data.title ?? '' });
  }

  private mutate(change: (s: PlotSpec) => void): void {
    const next = structuredClone(this.spec());
    change(next);
    this.commit(next);
  }

  setField(i: number, key: 'fn' | 'x' | 'y' | 'r', value: string): void {
    this.mutate((s) => ((s.expressions[i] as unknown as Record<string, string>)[key] = value));
  }
  setColor(i: number, value: string): void {
    this.mutate((s) => (s.expressions[i]!.color = value));
  }
  setKind(i: number, kind: PlotExpression['kind']): void {
    this.mutate((s) => {
      const color = s.expressions[i]!.color;
      s.expressions[i] = (kind === 'linear' ? { kind, fn: 'x' } : kind === 'parametric' ? { kind, x: 'cos(t)', y: 'sin(t)' } : { kind, r: '2*sin(3*theta)' }) as PlotExpression;
      s.expressions[i]!.color = color;
    });
  }
  add(): void {
    this.mutate((s) => s.expressions.push({ kind: 'linear', fn: 'x^2' }));
  }
  remove(i: number): void {
    this.mutate((s) => s.expressions.splice(i, 1));
  }
  setDomain(axis: 'x' | 'y', index: 0 | 1, raw: string): void {
    this.mutate((s) => {
      if (axis === 'x') s.xDomain[index] = num(raw, s.xDomain[index]);
      else {
        const cur = s.yDomain ?? [-10, 10];
        const blank = raw.trim() === '';
        const next: [number, number] = [...cur] as [number, number];
        next[index] = num(raw, cur[index]);
        s.yDomain = blank && !s.yDomain ? null : next;
      }
    });
  }
}
