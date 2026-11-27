import { Component, effect, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AppUpdates } from './core/app-updates';
import { AuthStore } from './core/auth-store';
import { Language } from './core/i18n';
import { Platform } from './core/platform';
import { Session } from './core/session';
import { ThemeService } from './core/theme';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
  styles: ':host { display: block; min-height: 100dvh; }',
})
export class App {
  constructor() {
    inject(ThemeService);
    inject(Session);
    const auth = inject(AuthStore);
    const lang = inject(Language);

    // The signed-in user's language wins over the browser's.
    effect(() => {
      const locale = auth.user()?.locale;
      if (locale) lang.set(locale);
    });

    // The desktop shell's native menu (File › New page, Search) asks the web app to do things it can do itself.
    const router = inject(Router);
    inject(Platform).desktop?.onMenuCommand((command) => {
      if (command === 'new-page') void router.navigate(['/app'], { queryParams: { new: 'page' }, onSameUrlNavigation: 'reload' });
      else if (command === 'search') void router.navigate(['/app/search']);
    });

    // New versions are downloaded in the background and switched to when nothing would be lost.
    inject(AppUpdates);
  }
}
