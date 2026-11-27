import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { FeaturesDto } from '@os-planner/shared/lite';
import { AuthStore } from '../core/auth-store';
import { RealtimeService } from '../core/realtime';

const KEY = 'os_planner.features';

/**
 * What this server can do (voice needs a media server, push needs keys). The website hides what is off. The last answer is kept on this
 * device so a page opened offline still knows; before the first answer nothing optional is shown.
 */
@Injectable({ providedIn: 'root' })
export class Features {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthStore);
  private readonly rt = inject(RealtimeService);

  readonly voice = signal(false);
  readonly push = signal(false);
  /** True once the server has answered (or an earlier answer was found on the device). */
  readonly known = signal(false);

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FeaturesDto> | null;
      if (saved) this.apply(saved);
    } catch {
      /* no storage: the first answer from the server does it */
    }
    effect(() => {
      if (this.auth.status() === 'authed') untracked(() => void this.refresh());
    });
    this.rt.resumed.subscribe(() => void this.refresh());
  }

  async refresh(): Promise<void> {
    try {
      const f = await firstValueFrom(this.http.get<FeaturesDto>('/api/features'));
      this.apply(f);
      try {
        localStorage.setItem(KEY, JSON.stringify(f));
      } catch {
        /* nothing to remember it in */
      }
    } catch {
      /* offline: what was known stays */
    }
  }

  private apply(f: Partial<FeaturesDto>): void {
    this.voice.set(f.voice === true);
    this.push.set(f.push === true);
    this.known.set(true);
  }
}
