import type { HttpInterceptorFn } from '@angular/common/http';
import { apiBase } from './api-config';

/**
 * Sends `/api/...` requests to the configured API. Code keeps writing plain `/api/...` paths; this is the only place
 * that knows the API may live on another origin.
 *
 * Listed after authInterceptor on purpose: that one recognises API calls by their `/api/` prefix.
 */
export const apiBaseInterceptor: HttpInterceptorFn = (req, next) => {
  const base = apiBase();
  if (!base || !req.url.startsWith('/api/')) return next(req);
  // The refresh cookie travels only on /api/auth/*. Cross-origin it is sent only when asked for explicitly.
  const withCredentials = req.withCredentials || req.url.startsWith('/api/auth/');
  return next(req.clone({ url: base + req.url, withCredentials }));
};
