import { Injectable, signal } from '@angular/core';

/** Whether the browser believes it has a network. (Requests can still fail on a captive portal; callers handle that.) */
@Injectable({ providedIn: 'root' })
export class Online {
  readonly isOnline = signal(typeof navigator === 'undefined' ? true : navigator.onLine);

  constructor() {
    addEventListener('online', () => this.isOnline.set(true));
    addEventListener('offline', () => this.isOnline.set(false));
  }
}
