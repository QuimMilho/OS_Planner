import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseEnvSchema, renderConfiguration } from './env-doc.mjs';

const root = resolve(import.meta.dirname, '../..');
const source = readFileSync(resolve(root, 'apps/server/src/config/env.ts'), 'utf8');

test('reads every setting of the schema with its default, type and doc comment', () => {
  const settings = parseEnvSchema(source);
  const by = Object.fromEntries(settings.map((s) => [s.name, s]));
  assert.ok(settings.length > 50);
  assert.deepEqual(
    by.PORT && { type: by.PORT.type, default: by.PORT.default, required: by.PORT.required },
    { type: 'integer', default: '3000', required: false },
  );
  assert.equal(by.APP_URL.required, true);
  assert.equal(by.TRUST_PROXY.type, 'boolean');
  assert.match(by.COOKIE_SAMESITE.type, /`strict`/);
  assert.match(by.REDIS_URL.doc, /Redis/);
  for (const s of settings) assert.match(s.name, /^[A-Z][A-Z0-9_]+$/);
});

test('docs/configuration.md is what the schema says (run `node scripts/env-doc.mjs` after changing env.ts)', () => {
  const current = readFileSync(resolve(root, 'docs/configuration.md'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  assert.equal(current, renderConfiguration(parseEnvSchema(source)));
});
