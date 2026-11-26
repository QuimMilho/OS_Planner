export const REFRESH_COOKIE = 'os_planner_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A rotated refresh token presented again within this window is treated as a benign race
 * (two tabs refreshing together), not as theft: the caller just gets a fresh sibling token.
 */
export const REFRESH_GRACE_MS = 10_000;

export const ACCESS_TTL_SECONDS = 15 * 60;
export const MEDIA_TTL_SECONDS = 60 * 60;

/** Required on cookie-authenticated endpoints: a cross-site form cannot set custom headers. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'os_planner';

export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
