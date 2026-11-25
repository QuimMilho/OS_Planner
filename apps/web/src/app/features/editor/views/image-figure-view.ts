import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { MediaStore } from '../../../data/media-store';

const WIDTHS = [25, 50, 75, 100];

/** A picture with caption, alignment and drag-to-resize. Shows from the local copy when there is one. */
@Component({
  selector: 'app-image-figure-view',
  imports: [MatIconModule, MatButtonModule, TranslocoPipe],
  host: { class: 'node-view' },
  template: `
    <figure class="fig" [attr.data-align]="attrs()['align']" [class.selected]="selected()" [style.width.%]="attrs()['width']">
      @if (src()) {
        <img [src]="src()" [alt]="attrs()['alt']" draggable="false" (error)="src.set(null)" />
      } @else {
        <div class="placeholder"><mat-icon>image_not_supported</mat-icon>{{ 'editor.mediaUnavailable' | transloco }}</div>
      }
      @if (selected()) {
        <span class="grip" (pointerdown)="startResize($event)" [attr.aria-label]="'editor.resize' | transloco"></span>
        <div class="bar" contenteditable="false">
          @for (a of aligns; track a.value) {
            <button mat-icon-button type="button" [class.on]="attrs()['align'] === a.value" (click)="set({ align: a.value })" [attr.aria-label]="a.label | transloco">
              <mat-icon>{{ a.icon }}</mat-icon>
            </button>
          }
          <span class="sep"></span>
          @for (w of widths; track w) {
            <button type="button" class="chip" [class.on]="attrs()['width'] === w" (click)="set({ width: w })">{{ w }}%</button>
          }
          <button type="button" class="chip" [class.on]="!attrs()['width']" (click)="set({ width: null })">{{ 'editor.original' | transloco }}</button>
          <span class="sep"></span>
          <button mat-icon-button type="button" (click)="deleteNode()()" [attr.aria-label]="'common.delete' | transloco"><mat-icon>delete</mat-icon></button>
        </div>
      }
      @if (selected() || attrs()['caption']) {
        <input class="cap" [value]="attrs()['caption']" (input)="set({ caption: $any($event.target).value })" [placeholder]="'editor.caption' | transloco" />
      }
      @if (selected()) {
        <input class="cap alt" [value]="attrs()['alt']" (input)="set({ alt: $any($event.target).value })" [placeholder]="'editor.altText' | transloco" />
      }
    </figure>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .fig { position: relative; margin: 0; max-width: 100%; }
    .fig[data-align='center'] { margin-inline: auto; text-align: center; }
    .fig[data-align='right'] { margin-left: auto; text-align: right; }
    .fig[data-align='left'] { margin-right: auto; text-align: left; }
    img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin-inline: auto; }
    .fig[data-align='left'] img { margin-left: 0; } .fig[data-align='right'] img { margin-right: 0; }
    .selected img { outline: 2px solid var(--accent); outline-offset: 2px; }
    .placeholder { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 28px; border: 1px dashed var(--border); border-radius: 8px; color: var(--text-dim); }
    .grip { position: absolute; right: -6px; bottom: 34px; width: 14px; height: 14px; border-radius: 50%; background: var(--accent); border: 2px solid var(--surface); cursor: nwse-resize; touch-action: none; }
    .bar { position: absolute; top: -44px; left: 50%; transform: translateX(-50%); z-index: 5; display: flex; align-items: center; gap: 2px; padding: 2px 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--mat-sys-level2); white-space: nowrap; }
    .bar .on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .chip { border: 0; background: none; color: var(--text); padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .chip:hover { background: var(--surface-3); } .chip.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
    .cap { display: block; width: 100%; margin-top: 4px; border: 0; background: transparent; text-align: center; font: inherit; font-size: 0.85em; color: var(--text-dim); outline: none; }
    .cap.alt { font-size: 0.75em; opacity: 0.8; }
  `,
})
export class ImageFigureView extends AngularNodeViewComponent {
  private readonly media = inject(MediaStore);
  readonly attrs = computed(() => this.node().attrs as Record<string, any>);
  readonly src = signal<string | null>(null);
  readonly widths = WIDTHS;
  readonly aligns = [
    { value: 'left', icon: 'format_align_left', label: 'editor.alignLeft' },
    { value: 'center', icon: 'format_align_center', label: 'editor.alignCenter' },
    { value: 'right', icon: 'format_align_right', label: 'editor.alignRight' },
  ];

  constructor() {
    super();
    effect(() => {
      const id = this.attrs()['mediaId'] as string | null;
      untracked(() => {
        if (id) void this.media.urlFor(id, 'image').then((u) => this.src.set(u));
      });
    });
  }

  set(patch: Record<string, unknown>): void {
    this.updateAttributes()(patch);
  }

  startResize(event: PointerEvent): void {
    event.preventDefault();
    const figure = (event.target as HTMLElement).closest('figure')!;
    const container = (figure.parentElement?.closest('.ProseMirror') as HTMLElement | null) ?? figure.parentElement!;
    const left = figure.getBoundingClientRect().left;
    const total = container.getBoundingClientRect().width;
    const move = (e: PointerEvent) => this.set({ width: Math.max(10, Math.min(100, Math.round(((e.clientX - left) / total) * 100))) });
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
}
