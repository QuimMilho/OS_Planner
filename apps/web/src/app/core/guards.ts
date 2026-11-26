import { inject } from '@angular/core';
import { Router, type CanActivateFn, type CanMatchFn } from '@angular/router';
import { AuthStore } from './auth-store';

/** Pages inside the app need a signed-in user; others are sent to sign in and brought back afterwards. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthStore);
  if (auth.status() === 'authed') return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Sign-in and registration are pointless for someone who already is. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthStore);
  return auth.status() === 'authed' ? inject(Router).createUrlTree(['/app']) : true;
};

/**
 * The admin area exists only for instance administrators. For everybody else the route does not
 * match, so the "not found" page answers at the same address (no hint that it exists). The server
 * enforces this too: its admin routes answer 404 to non-admins.
 */
export const adminMatch: CanMatchFn = () => inject(AuthStore).user()?.isAdmin === true;
