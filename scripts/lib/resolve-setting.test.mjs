import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { canPrompt, normaliseUrl, readDotEnv, resolveSetting, urlOrEmpty } from './resolve-setting.mjs';

const base = { name: 'NOTES_API_URL', question: 'API address?', validate: urlOrEmpty, envFile: join(tmpdir(), 'does-not-exist.env') };

/** A fake terminal: answers are written to stdin, the questions end up in `shown`. */
function terminal(answers) {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => (shown += chunk));
  input.end(answers.map((a) => `${a}\n`).join(''));
  return { input, output, text: () => shown };
}

function withEnvFile(content, run) {
  const dir = mkdtempSync(join(tmpdir(), 'notes-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, content);
  return Promise.resolve(run(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('normaliseUrl keeps origin and path, drops trailing slashes, query and hash', () => {
  assert.equal(normaliseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normaliseUrl(' http://localhost:3000/notes/// '), 'http://localhost:3000/notes');
  assert.equal(normaliseUrl('https://a.example.com/x?y=1#z'), 'https://a.example.com/x');
});

test('normaliseUrl reads a bare host as https and rejects other protocols and garbage', () => {
  assert.equal(normaliseUrl('api.example.com'), 'https://api.example.com');
  assert.equal(normaliseUrl('ftp://example.com'), null);
  assert.equal(normaliseUrl('javascript:alert(1)'), null);
  assert.equal(normaliseUrl('http://'), null);
  assert.equal(normaliseUrl(''), null);
  assert.equal(normaliseUrl(undefined), null);
});

test('urlOrEmpty allows an empty value (same origin)', () => {
  assert.equal(urlOrEmpty('  '), '');
  assert.equal(urlOrEmpty('nope://x'), null);
});

test('readDotEnv finds the key, strips quotes and trailing comments, and ignores a missing file', async () => {
  await withEnvFile('# comment\nA=1\nNOTES_API_URL="https://q.example.com"  \nB=https://c.example.com # note\nEMPTY=\n', (file) => {
    assert.equal(readDotEnv(file, 'NOTES_API_URL'), 'https://q.example.com');
    assert.equal(readDotEnv(file, 'B'), 'https://c.example.com');
    assert.equal(readDotEnv(file, 'EMPTY'), '');
    assert.equal(readDotEnv(file, 'MISSING'), undefined);
    assert.equal(readDotEnv(join(file, 'nope'), 'A'), undefined);
  });
});

test('the environment wins over .env, which wins over a question', async () => {
  await withEnvFile('NOTES_API_URL=https://file.example.com\n', async (envFile) => {
    const t = terminal(['https://typed.example.com']);
    const fromEnv = await resolveSetting({ ...base, envFile, env: { NOTES_API_URL: 'https://env.example.com/' }, ...t });
    assert.deepEqual(fromEnv, { value: 'https://env.example.com', source: 'env' });

    const fromFile = await resolveSetting({ ...base, envFile, env: {}, ...terminal(['https://typed.example.com']) });
    assert.deepEqual(fromFile, { value: 'https://file.example.com', source: 'file' });
  });
});

test('asks on an interactive terminal when nothing is configured', async () => {
  const t = terminal(['https://typed.example.com/']);
  const result = await resolveSetting({ ...base, env: {}, input: t.input, output: t.output });
  assert.deepEqual(result, { value: 'https://typed.example.com', source: 'prompt' });
  assert.match(t.text(), /API address\?/);
});

test('a blank answer means the default (same origin)', async () => {
  const t = terminal(['']);
  assert.deepEqual(await resolveSetting({ ...base, env: {}, input: t.input, output: t.output }), { value: '', source: 'prompt' });
});

test('an invalid answer is asked again', async () => {
  const t = terminal(['ftp://nope', 'https://ok.example.com']);
  const result = await resolveSetting({ ...base, env: {}, input: t.input, output: t.output });
  assert.equal(result.value, 'https://ok.example.com');
  assert.match(t.text(), /not an http\(s\) address/);
});

test('three invalid answers in a row fail instead of looping', async () => {
  const t = terminal(['x://1', 'y://2', 'z://3']);
  await assert.rejects(resolveSetting({ ...base, env: {}, input: t.input, output: t.output }), /no valid value/);
});

test('never asks without a terminal, in CI, with NOTES_NO_PROMPT, or when prompt is false', async () => {
  const noTty = new PassThrough(); // isTTY is undefined
  assert.deepEqual(await resolveSetting({ ...base, env: {}, input: noTty }), { value: '', source: 'default' });

  for (const env of [{ CI: 'true' }, { NOTES_NO_PROMPT: '1' }]) {
    const t = terminal(['https://typed.example.com']);
    const result = await resolveSetting({ ...base, env, input: t.input, output: t.output, defaultValue: 'https://fallback.example.com' });
    assert.deepEqual(result, { value: 'https://fallback.example.com', source: 'default' });
  }

  const t = terminal(['https://typed.example.com']);
  assert.equal((await resolveSetting({ ...base, env: {}, input: t.input, output: t.output, prompt: false })).source, 'default');
});

test('an explicitly empty variable counts as an answer (and skips the question)', async () => {
  const t = terminal(['https://typed.example.com']);
  const result = await resolveSetting({ ...base, env: { NOTES_API_URL: '' }, input: t.input, output: t.output });
  assert.deepEqual(result, { value: '', source: 'env' });
});

test('an invalid value in the environment fails the build with a readable message', async () => {
  await assert.rejects(resolveSetting({ ...base, env: { NOTES_API_URL: 'ftp://x' } }), /NOTES_API_URL is not valid/);
});

test('canPrompt reflects the terminal and the CI switches', () => {
  const tty = { isTTY: true };
  assert.equal(canPrompt({ env: {}, input: tty }), true);
  assert.equal(canPrompt({ env: { CI: '1' }, input: tty }), false);
  assert.equal(canPrompt({ env: { NOTES_NO_PROMPT: '1' }, input: tty }), false);
  assert.equal(canPrompt({ env: {}, input: {} }), false);
  assert.equal(canPrompt({ env: { CI: '1' }, input: {}, force: true }), true);
});
