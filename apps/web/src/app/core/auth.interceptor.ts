import { HttpErrorResponse, type HttpInterceptorFn, type HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthStore } from './auth-store';

/** Endpoints that authenticate with a cookie or a one-time token, not a bearer token. */
const PUBLIC_API = /^\/api\/auth\/(login|register|refresh|logout|forgot-password|reset-password|verify-email)\b/;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const auth = inject(AuthStore);
  const isPublic = PUBLIC_API.test(req.url);

  const withToken = (r: HttpRequest<unknown>) => {
    const token = auth.getToken();
    return token ? r.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : r;
  };

  return next(isPublic ? req : withToken(req)).pipe(
    catchError((err: unknown) => {
      // Expired access token: refresh once (shared with any other request that failed the same way) and retry.
      if (err instanceof HttpErrorResponse && err.status === 401 && !isPublic) {
        return from(auth.refresh()).pipe(
          switchMap((ok) => (ok && auth.getToken() ? next(withToken(req)) : throwError(() => err))),
        );
      }
      return throwError(() => err);
    }),
  );
};
