import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { CHART_TYPES, chartDataSchema, SERIES_PALETTE, type ChartData, type ChartOptions, type ChartType } from '@notes/shared';
import { ThemeService, chartColors } from '../../../core/theme';
import { loadLibs } from '../lazy-libs';

const num = (v: string): number => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : 0);

@Component({
  selector: 'app-chart-view',
  imports: [FormsModule, MatIconModule, MatButtonModule, TranslocoPipe],
  host: { class: 'node-view' },
  template: `
    <div class="box" [class.selected]="selected()">
      <div class="canvas-wrap"><canvas #canvas></canvas></div>
      @if (selected()) {
        <div class="editor" contenteditable="false">
          <div class="row">
            <label>{{ 'editor.chartType' | transloco }}
              <select [ngModel]="type()" (ngModelChange)="update({ type: $event })">
                @for (t of types; track t) { <option [value]="t">{{ 'editor.chartTypes.' + t | transloco }}</option> }
              </select>
            </label>
            <label class="grow">{{ 'editor.chartTitle' | transloco }}
              <input [ngModel]="options().title ?? ''" (ngModelChange)="update({ options: { ...options(), title: $event || undefined } })" />
            </label>
            <label class="chk"><input type="checkbox" [ngModel]="options().stacked ?? false" (ngModelChange)="update({ options: { ...options(), stacked: $event } })" /> {{ 'editor.stacked' | transloco }}</label>
          </div>
          <div class="grid-scroll">
            <table>
              <thead>
                <tr>
                  <th>{{ 'editor.label' | transloco }}</th>
                  @for (d of data().datasets; track $index; let s = $index) {
                    <th>
                      <input class="series" [ngModel]="d.label" (ngModelChange)="setSeriesLabel(s, $event)" [attr.aria-label]="'editor.series' | transloco" />
                      <input type="color" [ngModel]="d.color ?? palette[s % palette.length]" (ngModelChange)="setSeriesColor(s, $event)" [attr.aria-label]="'editor.color' | transloco" />
                      @if (data().datasets.length > 1) { <button type="button" class="x" (click)="removeSeries(s)" [attr.aria-label]="'common.delete' | transloco">×</button> }
                    </th>
                  }
                  <th><button mat-icon-button type="button" (click)="addSeries()" [attr.aria-label]="'editor.addSeries' | transloco"><mat-icon>add</mat-icon></button></th>
                </tr>
              </thead>
              <tbody>
                @for (label of data().labels; track $index; let r = $index) {
                  <tr>
                    <td><input [ngModel]="label" (ngModelChange)="setLabel(r, $event)" /></td>
                    @for (d of data().datasets; track $index; let s = $index) {
                      <td><input class="n" inputmode="decimal" [ngModel]="cell(s, r)" (ngModelChange)="setCell(s, r, $event)" /></td>
                    }
                    <td><button type="button" class="x" (click)="removeRow(r)" [attr.aria-label]="'common.delete' | transloco">×</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="row">
            <button mat-stroked-button type="button" (click)="addRow()"><mat-icon>add</mat-icon>{{ 'editor.addRow' | transloco }}</button>
            <button mat-stroked-button type="button" (click)="pasting.set(!pasting())"><mat-icon>content_paste</mat-icon>{{ 'editor.pasteData' | transloco }}</button>
          </div>
          @if (pasting()) {
            <textarea rows="5" [placeholder]="'editor.pasteHint' | transloco" (input)="importCsv($any($event.target).value)"></textarea>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .box { border: 1px solid transparent; border-radius: 10px; padding: 8px; }
    .selected { border-color: var(--accent); }
    .canvas-wrap { position: relative; height: 320px; max-width: 100%; } canvas { width: 100% !important; height: 100% !important; }
    .editor { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
    .row { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; } .grow { flex: 1; min-width: 140px; }
    label { display: flex; flex-direction: column; gap: 2px; color: var(--text-dim); } .chk { flex-direction: row; align-items: center; gap: 6px; }
    input:not([type='checkbox']):not([type='color']), select, textarea { border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; background: var(--surface-2); color: var(--text); font: inherit; }
    .grid-scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; } th, td { padding: 2px; white-space: nowrap; }
    input.series { width: 96px; } input.n { width: 80px; text-align: right; } input[type='color'] { width: 28px; height: 28px; padding: 0; border: 0; background: none; vertical-align: middle; }
    .x { border: 0; background: none; color: var(--text-dim); cursor: pointer; font-size: 16px; }
  `,
})
export class ChartView extends AngularNodeViewComponent {
  readonly types = CHART_TYPES;
  readonly palette = SERIES_PALETTE;
  readonly pasting = signal(false);
  readonly type = computed(() => this.node().attrs['type'] as ChartType);
  readonly data = computed(() => this.node().attrs['data'] as ChartData);
  readonly options = computed(() => (this.node().attrs['options'] ?? {}) as ChartOptions);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: { destroy(): void } | null = null;

  private readonly theme = inject(ThemeService);

  constructor() {
    super();
    effect(() => {
      const el = this.canvas()?.nativeElement;
      const [type, data, options] = [this.type(), this.data(), this.options()];
      this.theme.palette(); // a canvas does not follow CSS: draw again when the theme changes
      if (el) untracked(() => void this.draw(el, type, data, options));
    });
  }

  private async draw(el: HTMLCanvasElement, type: ChartType, data: ChartData, options: ChartOptions): Promise<void> {
    try {
      const libs = await loadLibs();
      this.chart?.destroy();
      // The print version has a fixed size; on screen the chart follows its container.
      this.chart = libs.chart(el, type, data, options, { animate: false, responsive: true, devicePixelRatio: window.devicePixelRatio, colors: chartColors() });
    } catch (e) {
      console.warn('chart failed', e);
    }
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  update(patch: { type?: ChartType; options?: ChartOptions; data?: ChartData }): void {
    if (patch.data && !chartDataSchema.safeParse(patch.data).success) return; // keep the last valid chart
    this.updateAttributes()(patch);
  }

  cell(s: number, r: number): string {
    const v = this.data().datasets[s]?.data[r];
    return typeof v === 'number' ? String(v) : v ? String((v as { y: number }).y) : '';
  }

  private edit(change: (d: ChartData) => void): void {
    const next = structuredClone(this.data());
    change(next);
    this.update({ data: next });
  }

  setLabel(r: number, v: string): void { this.edit((d) => (d.labels[r] = v)); }
  setCell(s: number, r: number, v: string): void { this.edit((d) => (d.datasets[s]!.data[r] = num(v))); }
  setSeriesLabel(s: number, v: string): void { this.edit((d) => (d.datasets[s]!.label = v)); }
  setSeriesColor(s: number, v: string): void { this.edit((d) => (d.datasets[s]!.color = v)); }
  addRow(): void { this.edit((d) => { d.labels.push(String(d.labels.length + 1)); d.datasets.forEach((x) => x.data.push(0)); }); }
  removeRow(r: number): void { this.edit((d) => { d.labels.splice(r, 1); d.datasets.forEach((x) => x.data.splice(r, 1)); }); }
  addSeries(): void { this.edit((d) => d.datasets.push({ label: `Series ${d.datasets.length + 1}`, data: d.labels.map(() => 0) })); }
  removeSeries(s: number): void { this.edit((d) => d.datasets.splice(s, 1)); }

  /** Accepts a pasted table (from a spreadsheet: tab- or comma-separated). First row = series names, first column = labels. */
  importCsv(text: string): void {
    const rows = text.trim().split(/\r?\n/).map((l) => l.split(/\t|;|,/).map((c) => c.trim()));
    if (rows.length < 2 || rows[0]!.length < 2) return;
    const header = rows[0]!.slice(1);
    const body = rows.slice(1);
    const next: ChartData = {
      labels: body.map((r) => r[0] ?? ''),
      datasets: header.map((name, i) => ({ label: name || `Series ${i + 1}`, data: body.map((r) => num(r[i + 1] ?? '')) })),
    };
    this.update({ data: next });
  }
}
