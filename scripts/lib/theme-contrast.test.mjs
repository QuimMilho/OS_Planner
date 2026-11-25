import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  THRESHOLDS,
  checkParity,
  checkThemes,
  contrast,
  parseColor,
  parseRules,
  readThemes,
  resolveValue,
  splitTopLevel,
  toHex,
} from './theme-contrast.mjs';

describe('colour maths', () => {
  test('reads hex, rgb, hsl and color(srgb) colours', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseColor('#1a1b1f'), [26, 27, 31]);
    assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30]);
    assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), [255, 0, 0]);
    assert.deepEqual(parseColor('hsl(120, 100%, 25%)'), [0, 128, 0]);
    assert.deepEqual(parseColor('color(srgb 0.5 0 1)'), [128, 0, 255]);
    assert.throws(() => parseColor('papayawhip'), /cannot read/);
  });

  test('contrast follows the WCAG 2 formula', () => {
    assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
    assert.equal(contrast([255, 255, 255], [255, 255, 255]).toFixed(2), '1.00');
    // the textbook "just fails AA" grey: #777 on white is 4.48:1, #767676 is 4.54:1
    assert.ok(contrast(parseColor('#777777'), [255, 255, 255]) < 4.5);
    assert.ok(contrast(parseColor('#767676'), [255, 255, 255]) >= 4.5);
    assert.equal(toHex([0, 128, 255]), '#0080ff');
  });
});

describe('reading a stylesheet', () => {
  test('splits arguments only at the top level', () => {
    assert.deepEqual(splitTopLevel('hsl(1, 2%, 3%), #fff'), ['hsl(1, 2%, 3%)', '#fff']);
  });

  test('resolves var() chains and light-dark() for the scheme asked for', () => {
    const props = {
      '--a': 'light-dark(#111111, hsl(0, 0%, 90%))',
      '--b': 'var(--a)',
      '--c': 'var(--b)',
    };
    assert.equal(resolveValue('var(--c)', props, 'light'), '#111111');
    assert.equal(resolveValue('var(--c)', props, 'dark'), 'hsl(0, 0%, 90%)');
    assert.throws(() => resolveValue('var(--missing)', props, 'light'), /not defined/);
    assert.throws(
      () => resolveValue('var(--x)', { '--x': 'var(--y)', '--y': 'var(--x)' }, 'light'),
      /loop/,
    );
  });

  test('flattens at-rules and keeps declarations', () => {
    const rules = parseRules(
      'html { --a: 1; color-scheme: dark; } @media (x) { html:not([data-theme]) { --b: 2; } }',
    );
    assert.deepEqual(rules, [
      { selector: 'html', decls: { '--a': '1', 'color-scheme': 'dark' } },
      { selector: 'html:not([data-theme])', decls: { '--b': '2' } },
    ]);
  });
});

describe('the real themes (apps/web/src/themes.scss)', () => {
  const themes = readThemes();

  test('there are the seven themes the picker offers, and the coloured ones are dark', () => {
    assert.deepEqual(Object.keys(themes).sort(), [
      'blue',
      'dark',
      'darkblue',
      'green',
      'light',
      'purple',
      'red',
    ]);
    assert.equal(themes.light.scheme, 'light');
    for (const id of ['dark', 'purple', 'red', 'green', 'blue', 'darkblue'])
      assert.equal(themes[id].scheme, 'dark', id);
  });

  test('body text reaches 4.5:1, the accent 3:1 and borders 1.5:1 in every theme', () => {
    const rows = checkThemes(themes);
    assert.ok(rows.length > 50);
    const failed = rows
      .filter((r) => !r.ok)
      .map((r) => `${r.theme}: ${r.check} ${r.ratio.toFixed(2)} < ${r.min}`);
    assert.deepEqual(failed, []);
    // the thresholds the acceptance criteria name
    assert.deepEqual(THRESHOLDS, { text: 4.5, accent: 3, border: 1.5, button: 4.5 });
  });

  test('every theme has its own accent, so choosing one is visible', () => {
    const accents = Object.values(themes).map((t) => toHex(t.colours['--accent']));
    assert.equal(new Set(accents).size, accents.length, accents.join(' '));
  });

  test('the shared Theme list and theme-boot.js name exactly the themes the stylesheet defines', () => {
    assert.deepEqual(checkParity(themes), []);
  });

  test('a failing palette is caught', () => {
    const grey = {
      scheme: 'dark',
      colours: Object.fromEntries(
        [
          '--surface',
          '--surface-2',
          '--surface-3',
          '--border',
          '--text',
          '--text-dim',
          '--accent',
          '--mat-sys-primary',
          '--mat-sys-on-primary',
        ].map((k) => [k, [60, 60, 60]]),
      ),
    };
    assert.ok(checkThemes({ dull: grey }).some((r) => !r.ok));
  });
});
