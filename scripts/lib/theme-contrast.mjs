// Checks that every theme is readable. It compiles the real `apps/web/src/themes.scss`, works out the
// colours each theme ends up with (resolving var(...) and light-dark(...)) and measures them with the
// WCAG 2 contrast formula, so a new palette cannot ship with unreadable text.
//   node scripts/check-theme-contrast.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sass from 'sass';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const THEMES_SCSS = resolve(ROOT, 'apps/web/src/themes.scss');
export const THEME_BOOT = resolve(ROOT, 'apps/web/public/theme-boot.js');
const SHARED_THEMES = resolve(ROOT, 'packages/shared/src/dto/common.ts');

/** What each pair of colours has to reach. Body text 4.5:1 (WCAG AA), graphics and the accent 3:1, borders 1.5:1. */
export const THRESHOLDS = { text: 4.5, accent: 3, border: 1.5, button: 4.5 };

// ---------------------------------------------------------------------------------------------- colours

/** Accepts #rgb, #rrggbb, rgb(), hsl() and color(srgb r g b): everything Sass and Material can emit. Returns [r, g, b] in 0..255. */
export function parseColor(input) {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (m) {
    const h = (Number(m[1]) % 360) / 360;
    const sat = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const channel = (t) => {
      t = (t + 1) % 1;
      const v =
        t < 1 / 6
          ? p + (q - p) * 6 * t
          : t < 1 / 2
            ? q
            : t < 2 / 3
              ? p + (q - p) * (2 / 3 - t) * 6
              : p;
      return Math.round(v * 255);
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  }
  m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v * 255));
  throw new Error(`cannot read the colour "${input}"`);
}

export function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const toHex = (rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** HSL lightness in percent, to see how dark a surface is. */
export function lightness([r, g, b]) {
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255) * 100;
}

// ---------------------------------------------------------------------------------------------- CSS

/** Splits at commas that are not inside parentheses. */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** The rules of a compiled stylesheet as `{ selector, decls }`. At-rules are flattened; the selector keeps nothing of the @media. */
export function parseRules(css) {
  const rules = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  let buffer = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ selector: buffer.trim(), decls: {}, atRule: buffer.trim().startsWith('@') });
      buffer = '';
    } else if (ch === '}') {
      const top = stack.pop();
      if (buffer.trim() && top) addDecl(top.decls, buffer);
      buffer = '';
      if (top && !top.atRule) rules.push({ selector: top.selector, decls: top.decls });
    } else if (ch === ';') {
      const top = stack.at(-1);
      if (top) addDecl(top.decls, buffer);
      buffer = '';
    } else buffer += ch;
  }
  return rules;
}

function addDecl(decls, text) {
  const i = text.indexOf(':');
  if (i > 0) decls[text.slice(0, i).trim()] = text.slice(i + 1).trim();
}

/** Resolves var(--x) and light-dark(a, b) in a custom property's value for one colour scheme. */
export function resolveValue(value, props, scheme, depth = 0) {
  if (depth > 20) throw new Error(`variables refer to each other in a loop: ${value}`);
  let out = value.trim();
  for (let guard = 0; guard < 50; guard++) {
    const v = /var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/.exec(out);
    if (v) {
      const target = props[v[1]];
      if (target === undefined) throw new Error(`${v[1]} is not defined (needed by ${value})`);
      out = out.replace(v[0], resolveValue(target, props, scheme, depth + 1));
      continue;
    }
    const ld = /light-dark\(/.exec(out);
    if (ld) {
      let depthParens = 0;
      let end = -1;
      for (let i = ld.index + 'light-dark'.length; i < out.length; i++) {
        if (out[i] === '(') depthParens++;
        else if (out[i] === ')' && --depthParens === 0) {
          end = i;
          break;
        }
      }
      const [light, dark] = splitTopLevel(out.slice(ld.index + 'light-dark('.length, end));
      out = out.slice(0, ld.index) + (scheme === 'dark' ? dark : light) + out.slice(end + 1);
      continue;
    }
    break;
  }
  return out.trim();
}

// Sass writes `html[data-theme=purple]` (it drops the quotes when it can); accept both spellings.
const attr = (selector) => /^(?:html)?\[data-theme=['"]?([\w-]+)['"]?\]$/.exec(selector)?.[1];

/** Compiles themes.scss and returns, per theme id, its scheme and the resolved colours of the variables that matter. */
export function readThemes(scssPath = THEMES_SCSS) {
  const css = sass.compile(scssPath, {
    loadPaths: [resolve(ROOT, 'node_modules')],
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin'],
  }).css;
  const rules = parseRules(css);
  const declsOf = (match) =>
    Object.assign({}, ...rules.filter((r) => match(r.selector)).map((r) => r.decls));
  const root = declsOf((s) => s === ':root');
  const base = declsOf((s) => s === 'html');

  const ids = [...new Set(rules.map((r) => attr(r.selector)).filter(Boolean))];
  const themes = {};
  for (const id of ids) {
    const own = declsOf((s) => attr(s) === id);
    const props = { ...root, ...base, ...own };
    const scheme = props['color-scheme'] === 'dark' ? 'dark' : 'light';
    const colours = {};
    for (const name of [
      '--surface',
      '--surface-2',
      '--surface-3',
      '--border',
      '--text',
      '--text-dim',
      '--accent',
      '--mat-sys-primary',
      '--mat-sys-on-primary',
    ]) {
      colours[name] = parseColor(resolveValue(`var(${name})`, props, scheme));
    }
    themes[id] = { scheme, colours };
  }
  return themes;
}

// ---------------------------------------------------------------------------------------------- the checks

/** Returns one row per check: `{ theme, check, ratio, min, ok }`. */
export function checkThemes(themes) {
  const rows = [];
  const add = (theme, check, a, b, min) => {
    const ratio = contrast(a, b);
    rows.push({ theme, check, ratio, min, ok: ratio >= min });
  };
  for (const [theme, { colours: c, scheme }] of Object.entries(themes)) {
    for (const surface of ['--surface', '--surface-2', '--surface-3']) {
      add(theme, `text on ${surface}`, c['--text'], c[surface], THRESHOLDS.text);
      add(theme, `dim text on ${surface}`, c['--text-dim'], c[surface], THRESHOLDS.text);
      add(theme, `accent on ${surface}`, c['--accent'], c[surface], THRESHOLDS.accent);
    }
    add(theme, 'border on --surface', c['--border'], c['--surface'], THRESHOLDS.border);
    add(
      theme,
      'button label on primary',
      c['--mat-sys-on-primary'],
      c['--mat-sys-primary'],
      THRESHOLDS.button,
    );
    // A coloured theme must really be dark and understated: dark surfaces, not a colour-washed page.
    if (!['light', 'dark'].includes(theme)) {
      const l = lightness(c['--surface']);
      rows.push({
        theme,
        check: `dark surface (lightness ${l.toFixed(0)} %)`,
        ratio: l,
        min: 0,
        ok: scheme === 'dark' && l <= 14,
      });
    }
  }
  // Each theme must look different from every other one, or the picker is a lie.
  const ids = Object.keys(themes);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = themes[ids[i]].colours;
      const b = themes[ids[j]].colours;
      const same =
        toHex(a['--surface']) === toHex(b['--surface']) &&
        toHex(a['--accent']) === toHex(b['--accent']);
      if (same)
        rows.push({
          theme: `${ids[i]} / ${ids[j]}`,
          check: 'look different',
          ratio: 0,
          min: 0,
          ok: false,
        });
    }
  }
  return rows;
}

/** The ids the rest of the app knows (shared enum, the no-flash script) must be exactly the ones the stylesheet defines. */
export function checkParity(themes) {
  const problems = [];
  const shared = /THEMES = \[([^\]]+)\]/
    .exec(readFileSync(SHARED_THEMES, 'utf8'))?.[1]
    .match(/'([\w]+)'/g)
    ?.map((s) => s.slice(1, -1));
  if (!shared) return ['packages/shared/src/dto/common.ts: THEMES list not found'];
  const styled = Object.keys(themes).sort();
  const named = shared.filter((t) => t !== 'system').sort();
  if (styled.join() !== named.join())
    problems.push(`themes.scss defines [${styled}] but @notes/shared lists [${named}]`);
  const boot = /\/\^\(([^)]+)\)\$\/\.test/
    .exec(readFileSync(THEME_BOOT, 'utf8'))?.[1]
    .split('|')
    .sort();
  if (!boot) problems.push('theme-boot.js: the list of theme ids was not found');
  else if (boot.join() !== named.join())
    problems.push(`theme-boot.js accepts [${boot}] but @notes/shared lists [${named}]`);
  return problems;
}
