/** What the updater knows about the app when it decides whether a downloaded update may be installed now. */
export interface InstallContext {
  /** The website reported unsaved work, a call or an open dialog. */
  webBusy: boolean;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  /** Seconds since the last keyboard or mouse input anywhere on the computer. */
  idleSeconds: number;
}

const FIVE_MINUTES = 5 * 60;
const FIFTEEN_MINUTES = 15 * 60;

/**
 * A silent update restarts the app, so it only happens when nobody is looking at it: the window is hidden or minimised,
 * or the computer has been left alone for a while. Anything the website says is in progress always wins.
 */
export function shouldInstallNow(ctx: InstallContext): boolean {
  if (ctx.webBusy) return false;
  if (ctx.minimized || !ctx.visible) return true;
  if (!ctx.focused && ctx.idleSeconds >= FIVE_MINUTES) return true;
  return ctx.idleSeconds >= FIFTEEN_MINUTES;
}
