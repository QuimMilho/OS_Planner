#!/usr/bin/env node
// Writes docs/configuration.md from the server's configuration schema. `--check` only compares (exit 1 when out of date).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvSchema, renderConfiguration } from './lib/env-doc.mjs';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'apps/server/src/config/env.ts'), 'utf8');
const target = resolve(root, 'docs/configuration.md');
const text = renderConfiguration(parseEnvSchema(source));

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // missing counts as out of date
  }
  if (current !== text) {
    console.error('docs/configuration.md is out of date: run `node scripts/env-doc.mjs`');
    process.exit(1);
  }
  console.log('docs/configuration.md is up to date');
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target}`);
}
