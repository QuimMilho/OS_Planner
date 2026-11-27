import { Injectable, inject, isDevMode, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { provideTransloco, TranslocoService, type Translation, type TranslocoLoader } from '@jsverse/transloco';
import { firstValueFrom, from, of } from 'rxjs';
import type { Locale } from '@os-planner/shared';
import en from '../i18n/en.json';

const LANG_KEY = 'os_planner.lang';

/**
 * Translations ship with the app, not from a server: English (the fallback) is in the first bundle, every other language is a
 * chunk of the build that the service worker keeps with the rest of the app, so the UI is translated online or offline.
 */
@Injectable({ providedIn: 'root' })
export class InlineTranslationLoader implements TranslocoLoader {
  getTranslation(lang: string) {
    if (lang === 'pt') return from(import('../i18n/pt.json').then((m) => m.default as Translation));
    return of(en as Translation);
  }
}

export function detectLanguage(): Locale {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'pt') return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export function provideI18n() {
  return makeEnvironmentProviders([provideI18nCore(), provideAppInitializer(() => firstValueFrom(inject(TranslocoService).load(detectLanguage())))]);
}

function provideI18nCore() {
  return provideTransloco({
    config: {
      availableLangs: ['en', 'pt'],
      defaultLang: detectLanguage(),
      fallbackLang: 'en',
      reRenderOnLangChange: true,
      prodMode: !isDevMode(),
    },
    loader: InlineTranslationLoader,
  });
}

@Injectable({ providedIn: 'root' })
export class Language {
  private readonly transloco = inject(TranslocoService);

  get current(): Locale {
    return this.transloco.getActiveLang() as Locale;
  }

  set(lang: Locale): void {
    this.transloco.setActiveLang(lang);
    document.documentElement.lang = lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* storage unavailable */
    }
  }

  /** Looks a key up now (for snackbars, dialogs and other imperative text). */
  t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }

  /** Date formatting in the active language. */
  date(value: string | Date, style: 'short' | 'long' = 'short'): string {
    return new Intl.DateTimeFormat(this.current === 'pt' ? 'pt-PT' : 'en-GB', {
      dateStyle: style === 'long' ? 'long' : 'medium',
      timeStyle: style === 'long' ? 'short' : undefined,
    }).format(new Date(value));
  }
}
