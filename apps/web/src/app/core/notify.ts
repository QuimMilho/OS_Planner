import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Language } from './i18n';

@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly bar = inject(MatSnackBar);
  private readonly lang = inject(Language);

  info(key: string, params?: Record<string, unknown>, action?: { key: string; run: () => void }): void {
    const ref = this.bar.open(this.lang.t(key, params), action ? this.lang.t(action.key) : undefined, { duration: action ? 8000 : 4000 });
    if (action) ref.onAction().subscribe(action.run);
  }

  error(key: string, params?: Record<string, unknown>): void {
    this.bar.open(this.lang.t(key, params), this.lang.t('common.close'), { duration: 7000, panelClass: 'snack-error' });
  }
}
