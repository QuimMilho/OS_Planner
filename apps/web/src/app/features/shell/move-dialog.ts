import { Component, computed, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { TreeStore, type CategoryNode } from '../../data/tree-store';

export interface MoveData {
  kind: 'page' | 'category';
  id: string;
}
export interface MoveTarget {
  categoryId: string | null;
  notebookId: string;
}

interface Option {
  categoryId: string | null;
  notebookId: string;
  label: string;
  depth: number;
  /** A category cannot be moved into itself or its own subcategories. */
  disabled: boolean;
  heading: boolean;
}

@Component({
  selector: 'app-move-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'tree.moveTo' | transloco }}</h2>
    <mat-dialog-content>
      <div class="list" role="listbox">
        @for (o of options(); track o.categoryId ?? o.notebookId) {
          @if (o.heading) {
            <div class="nb"><mat-icon>book</mat-icon>{{ o.label }}</div>
          } @else {
            <button type="button" role="option" class="opt" [style.padding-left.px]="16 + o.depth * 16" [disabled]="o.disabled" (click)="ref.close({ categoryId: o.categoryId, notebookId: o.notebookId })">
              <mat-icon>folder</mat-icon>{{ o.label }}
            </button>
          }
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button mat-button type="button" mat-dialog-close>{{ 'common.cancel' | transloco }}</button></mat-dialog-actions>
  `,
  styles: `
    .list { min-width: 300px; max-height: 50vh; overflow: auto; }
    .nb { display: flex; gap: 8px; align-items: center; font-weight: 600; padding: 10px 8px 4px; color: var(--text-dim); font-size: 13px; }
    .opt { display: flex; gap: 8px; align-items: center; width: 100%; border: 0; background: none; color: var(--text); padding: 8px 16px; border-radius: 8px; cursor: pointer; text-align: left; font: inherit; }
    .opt:hover:not(:disabled) { background: var(--surface-3); } .opt:disabled { opacity: 0.4; cursor: not-allowed; } mat-icon { font-size: 20px; width: 20px; height: 20px; }
  `,
})
export class MoveDialog {
  readonly data = inject<MoveData>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<MoveDialog, MoveTarget>>(MatDialogRef);
  private readonly store = inject(TreeStore);

  readonly options = computed<Option[]>(() => {
    const out: Option[] = [];
    const add = (nodes: CategoryNode[], notebookId: string, depth: number, blocked: boolean) => {
      for (const n of nodes) {
        const isSelf = this.data.kind === 'category' && n.category.id === this.data.id;
        out.push({ categoryId: n.category.id, notebookId, label: n.category.name, depth, disabled: blocked || isSelf, heading: false });
        add(n.children, notebookId, depth + 1, blocked || isSelf);
      }
    };
    for (const nb of this.store.tree()) {
      out.push({ categoryId: null, notebookId: nb.notebook.id, label: nb.notebook.name, depth: 0, disabled: true, heading: true });
      // A category can only move within its own notebook (the server enforces the same rule).
      const crossNotebook = this.data.kind === 'category' && this.store.categoryById().get(this.data.id)?.notebookId !== nb.notebook.id;
      add(nb.roots, nb.notebook.id, 0, crossNotebook);
    }
    return out;
  });
}
