import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { loadApiConfig } from './app/core/api-config';

// The API address is read first: every request, including the session resume at start-up, depends on it.
loadApiConfig()
  .then(() => bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));
