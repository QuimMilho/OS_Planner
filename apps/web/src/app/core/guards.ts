import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
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
