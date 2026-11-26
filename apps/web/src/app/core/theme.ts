import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Theme } from '@os-planner/shared';
import { THEMES } from '@os-planner/shared';
import { AuthStore, isUnreachable } from './auth-store';

/** What the last chosen theme is remembered as on this device (also read by `public/theme-boot.js` before the first paint). */
const THEME_KEY = 'os_planner.theme';
/** Set while a choice has not reached the account yet (made offline, or the request failed). */
const PENDING_KEY = 'os_planner.theme.pending';

/** The themes whose colour scheme is dark. Keep in step with `$dark-themes` in themes.scss. */
export const DARK_THEMES: ReadonlySet<Theme> = new Set<Theme>([
  'dark',
  'purple',
  'red',
  'green',
  'blue',
  'darkblue',
]);

const isTheme = (v: unknown): v is Theme =>
  typeof v === 'string' && (THEMES as readonly string[]).includes(v);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice still applies for this visit */
  }
}

/**
 * The colour of a CSS expression as the browser resolves it now (`var(--surface)`, a light-dark() token, ...).
 * Custom properties keep their unresolved text, so a computed `color` on a probe element is the way to get a real colour,
 * which canvas drawings (charts) and `<meta name="theme-color">` need.
 */
export function cssColor(expression: string): string {
  const probe = document.createElement('span');
  probe.style.color = expression;
  document.documentElement.appendChild(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/** Text and grid colours for a chart drawn on a canvas, which cannot read CSS variables itself. */
export function chartColors(): { text: string; grid: string } {
  const text = cssColor('var(--text)');
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text);
  return { text, grid: m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0.18)` : text };
}

const hex = (rgb: string): string => {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(rgb);
  return m
    ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
    : rgb;
};

/**
 * The colour theme. The choice belongs to the account (it follows the person to every device and is restored at login);
 * this device keeps a copy so logged-out screens and the next start use it too. With no choice, or `system`, the operating
 * system decides between light and dark and the page follows it live.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly auth = inject(AuthStore);
  private readonly osDark =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  /** What the person picked: one of the eight values, `system` included. */
  readonly choice = signal<Theme>(this.cached());
  private readonly osIsDark = signal(!!this.osDark?.matches);
  private pending = read(PENDING_KEY) === '1';
  private flushing: Promise<void> | null = null;

  /** The scheme on screen after resolving `system`. Mermaid and anything else that has only "light" or "dark" reads this. */
  readonly scheme = computed<'light' | 'dark'>(() => {
    const c = this.choice();
    return (c === 'system' ? this.osIsDark() : DARK_THEMES.has(c)) ? 'dark' : 'light';
  });
  /** Counts every time the colours on screen changed. Drawings that take their colours from CSS redraw when it moves. */
  readonly palette = signal(0);

  constructor() {
    // The signed-in account decides, unless a choice made here has not been delivered yet (then ours wins and is sent).
    effect(() => {
      const user = this.auth.user();
      const offline = this.auth.offlineSession();
      untracked(() => {
        if (!user) return;
        if (this.pending) {
          if (!offline) void this.flush();
        } else if (isTheme(user.theme)) this.choice.set(user.theme);
      });
    });

    effect(() => {
      const choice = this.choice();
      if (choice === 'system') this.osIsDark(); // only `system` changes with the OS
      untracked(() => this.apply(choice));
    });

    this.osDark?.addEventListener('change', (e) => this.osIsDark.set(e.matches));
    addEventListener('online', () => void this.flush());
  }

  /** The person picked a theme: it applies at once, is remembered here, and is saved to the account (now, or when back online). */
  async choose(theme: Theme): Promise<void> {
    if (!isTheme(theme)) return;
    this.choice.set(theme);
    if (this.auth.user()) {
      this.setPending(true);
      await this.flush();
    }
  }

  private cached(): Theme {
    const t = read(THEME_KEY);
    return isTheme(t) ? t : 'system';
  }

  private setPending(value: boolean): void {
    this.pending = value;
    write(PENDING_KEY, value ? '1' : null);
  }

  /** Sends a choice that has not reached the account yet. Safe to call at any time; it only acts when there is something to send. */
  private flush(): Promise<void> {
    return (this.flushing ??= this.send().finally(() => (this.flushing = null)));
  }

  private async send(): Promise<void> {
    while (this.pending && this.auth.user() && this.auth.getToken()) {
      const sent = this.choice();
      try {
        await this.auth.updateProfile({ theme: sent });
      } catch (e) {
        // Unreachable now: stays pending and is retried when the connection returns. Anything else is a refusal; retrying cannot help.
        if (!isUnreachable(e)) this.setPending(false);
        else this.retryLater();
        return;
      }
      if (this.choice() === sent) this.setPending(false); // otherwise it changed while the request was in flight: send the new one
    }
  }

  /** The browser says it is online a moment before requests get through: try again shortly, until it is delivered. */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryLater(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flush(), 3000);
  }

  private apply(theme: Theme): void {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    write(THEME_KEY, theme);
    // The browser's own chrome (address bar, installed-app title bar) takes the page colour.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', hex(cssColor('var(--surface)')));
    this.palette.update((n) => n + 1);
  }
}
