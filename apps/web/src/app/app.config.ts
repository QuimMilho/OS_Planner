import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { AuthStore } from './core/auth-store';
import { apiBaseInterceptor } from './core/api-base.interceptor';
import { authInterceptor } from './core/auth.interceptor';
import { provideI18n } from './core/i18n';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor, apiBaseInterceptor]), withFetch()),
    provideI18n(),
    // Resume the session before the first route renders, so guards and the shell know who is signed in.
    provideAppInitializer(() => inject(AuthStore).init()),
    provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:30000' }),
  ],
};
