import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { MediaStore } from '../../../data/media-store';

@Component({
  selector: 'app-video-view',
  imports: [MatIconModule, MatButtonModule, TranslocoPipe],
  host: { class: 'node-view' },
  template: `
    <figure class="fig" [class.selected]="selected()" [style.width.%]="attrs()['width']">
      @if (src()) {
        <video [src]="src()" [poster]="poster() ?? ''" controls preload="metadata" playsinline></video>
      } @else {
        <div class="placeholder"><mat-icon>videocam_off</mat-icon>{{ 'editor.mediaUnavailable' | transloco }}</div>
      }
      @if (selected()) {
        <div class="bar" contenteditable="false">
          @for (w of widths; track w) {
            <button type="button" class="chip" [class.on]="attrs()['width'] === w" (click)="set({ width: w })">{{ w }}%</button>
          }
          <button type="button" class="chip" [class.on]="!attrs()['width']" (click)="set({ width: null })">{{ 'editor.original' | transloco }}</button>
          <button mat-icon-button type="button" (click)="deleteNode()()" [attr.aria-label]="'common.delete' | transloco"><mat-icon>delete</mat-icon></button>
        </div>
      }
      @if (selected() || attrs()['caption']) {
        <input class="cap" [value]="attrs()['caption']" (input)="set({ caption: $any($event.target).value })" [placeholder]="'editor.caption' | transloco" />
      }
    </figure>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .fig { position: relative; margin: 0 auto; max-width: 100%; }
    video { width: 100%; border-radius: 8px; background: #000; display: block; }
    .selected video { outline: 2px solid var(--accent); outline-offset: 2px; }
    .placeholder { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 28px; border: 1px dashed var(--border); border-radius: 8px; color: var(--text-dim); }
    .bar { position: absolute; top: -44px; left: 50%; transform: translateX(-50%); z-index: 5; display: flex; align-items: center; gap: 2px; padding: 2px 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--mat-sys-level2); white-space: nowrap; }
    .chip { border: 0; background: none; color: var(--text); padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .chip:hover { background: var(--surface-3); } .chip.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .cap { display: block; width: 100%; margin-top: 4px; border: 0; background: transparent; text-align: center; font: inherit; font-size: 0.85em; color: var(--text-dim); outline: none; }
  `,
})
export class VideoView extends AngularNodeViewComponent {
  private readonly media = inject(MediaStore);
  readonly attrs = computed(() => this.node().attrs as Record<string, any>);
  readonly src = signal<string | null>(null);
  readonly poster = signal<string | null>(null);
  readonly widths = [50, 75, 100];

  constructor() {
    super();
    effect(() => {
      const { mediaId, posterId } = this.attrs() as { mediaId: string | null; posterId: string | null };
      untracked(() => {
        if (mediaId) void this.media.urlFor(mediaId, 'video').then((u) => this.src.set(u));
        if (posterId) void this.media.urlFor(posterId, 'image').then((u) => this.poster.set(u));
      });
    });
  }

  set(patch: Record<string, unknown>): void {
    this.updateAttributes()(patch);
  }
}
