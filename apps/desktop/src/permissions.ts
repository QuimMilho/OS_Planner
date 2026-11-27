/**
 * What the page in the window may ask the computer for. Pure (no Electron import) so a test can pin it down.
 *
 * The window only ever shows the OS_Planner website, and that is the only origin that may use the microphone, camera or screen
 * (voice and video channels). Anything else a page might ask for (location, notifications of other kinds, midi, usb...) stays off.
 */
const EVERYWHERE = new Set(['clipboard-sanitized-write', 'fullscreen']);
/** `media` is the microphone and the camera, `display-capture` is the screen. */
const SITE_ONLY = new Set(['media', 'display-capture']);

export const originOf = (url: string | undefined | null): string | null => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** `requester` is the address or origin of the page that asks; `site` the origin of the OS_Planner server the window shows. */
export function mayUse(
  permission: string,
  requester: string | undefined | null,
  site: string | null,
): boolean {
  if (EVERYWHERE.has(permission)) return true;
  if (!SITE_ONLY.has(permission)) return false;
  const who = originOf(requester);
  return who !== null && site !== null && who === site;
}
