// Contrast check for every theme. Run it after changing apps/web/src/themes.scss.
import { checkParity, checkThemes, readThemes, toHex } from './lib/theme-contrast.mjs';

const themes = readThemes();
const rows = checkThemes(themes);
const problems = checkParity(themes);

for (const [id, t] of Object.entries(themes)) {
  const c = t.colours;
  console.log(
    `${id.padEnd(9)} ${t.scheme.padEnd(5)} surface ${toHex(c['--surface'])}  text ${toHex(c['--text'])}  accent ${toHex(c['--accent'])}`,
  );
}
const failed = rows.filter((r) => !r.ok);
for (const r of failed)
  console.error(`FAIL ${r.theme}: ${r.check} = ${r.ratio.toFixed(2)} (needs ${r.min})`);
for (const p of problems) console.error(`FAIL ${p}`);
console.log(
  `${rows.length - failed.length}/${rows.length} contrast checks passed across ${Object.keys(themes).length} themes`,
);
process.exit(failed.length || problems.length ? 1 : 0);
