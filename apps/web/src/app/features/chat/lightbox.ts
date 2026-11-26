import { Component, HostListener, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { AttachmentDto } from '@os-planner/shared';

/** A picture shown large over the page. Esc, the close button or a click outside closes it. */
@Component({
  selector: 'app-lightbox',
  imports: [MatIconModule, TranslocoPipe],
  template: `
    <div
      class="back"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="attachment().name"
      (click)="closed.emit()"
      data-lightbox
    >
      <figure (click)="$event.stopPropagation()">
        <img [src]="src()" [alt]="attachment().name" />
        <figcaption>
          <span>{{ attachment().name }}</span>
          <a
            [href]="src()"
            target="_blank"
            rel="noopener noreferrer"
            [attr.download]="attachment().name"
            [attr.aria-label]="'attachment.download' | transloco"
            ><mat-icon>download</mat-icon></a
          >
          <button
            type="button"
            (click)="closed.emit()"
            [attr.aria-label]="'common.close' | transloco"
            data-action="close-lightbox"
            autofocus
          >
            <mat-icon>close</mat-icon>
          </button>
        </figcaption>
      </figure>
    </div>
  `,
  styles: `
    .back {
      position: fixed;
      inset: 0;
      z-index: 2000;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.82);
      padding: 24px;
    }
    figure {
      margin: 0;
      max-width: 100%;
      max-height: 100%;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    img {
      max-width: 92vw;
      max-height: 80vh;
      object-fit: contain;
      border-radius: 8px;
      background: #111;
    }
    figcaption {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #fff;
      font-size: 14px;
    }
    figcaption span {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    a,
    button {
      color: #fff;
      background: none;
      border: 0;
      cursor: pointer;
      display: grid;
      place-items: center;
    }
  `,
})
export class Lightbox {
  readonly attachment = input.required<AttachmentDto>();
  readonly src = input.required<string>();
  readonly closed = output<void>();

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }
}
