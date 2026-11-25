// Resolves a build-time setting: environment -> repo .env -> interactive question -> default.
// Used by the web and desktop builds to ask where the API lives. Nothing here talks to the network.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

export const REPO_ENV_FILE = resolve(import.meta.dirname, '../../.env');

/**
 * Accepts only http(s) addresses and returns origin + path without a trailing slash (query and hash are dropped).
 * A bare host such as "api.example.com" is read as https. Returns null when the input is not usable.
 */
export function normaliseUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Validator for settings that hold an http(s) address. An empty value is allowed and means "not set". */
export const urlOrEmpty = (value) => (String(value ?? '').trim() === '' ? '' : normaliseUrl(value));

/** Reads NAME=value from a dotenv-style file. Returns undefined when the file or the line is missing. */
export function readDotEnv(file, name) {
  if (!existsSync(file)) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=(.*)$`, 'm').exec(readFileSync(file, 'utf8'));
  if (!match) return undefined;
  let value = match[1].trim();
  if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, '');
  return value;
}

/** True when it is reasonable to ask the person running the build a question. */
export function canPrompt({ env = process.env, input = process.stdin, force } = {}) {
  if (force !== undefined) return force;
  return Boolean(input.isTTY) && !env.CI && !env.NOTES_NO_PROMPT;
}

/**
 * @param {object} options
 * @param {string} options.name          Environment variable / .env key, e.g. NOTES_API_URL.
 * @param {string} options.question      Shown when the person is asked.
 * @param {(value: string) => string | null} options.validate  Returns the normalised value, or null when invalid.
 * @param {string} [options.defaultValue]
 * @param {boolean} [options.prompt]     false never asks (e.g. `npm start`); undefined asks only on an interactive terminal.
 * @returns {Promise<{ value: string, source: 'env' | 'file' | 'prompt' | 'default' }>}
 */
export async function resolveSetting({
  name,
  question,
  validate,
  defaultValue = '',
  prompt,
  env = process.env,
  envFile = REPO_ENV_FILE,
  input = process.stdin,
  output = process.stdout,
}) {
  const accept = (raw, source) => {
    // An explicitly empty value ("NOTES_API_URL=") is a decision, not a gap: it means the default.
    if (String(raw).trim() === '') return { value: defaultValue, source };
    const value = validate(String(raw));
    if (value === null) throw new Error(`${name} is not valid: "${raw}". Expected an http(s) address such as https://api.example.com`);
    return { value, source };
  };

  if (env[name] !== undefined) return accept(env[name], 'env');

  const fromFile = readDotEnv(envFile, name);
  if (fromFile !== undefined) return accept(fromFile, 'file');

  if (prompt !== false && canPrompt({ env, input, force: prompt })) {
    const rl = createInterface({ input, output });
    // The line iterator buffers input, so answers that arrive before they are asked for (pasted or piped) are not lost.
    const lines = rl[Symbol.asyncIterator]();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        output.write(`${question}${defaultValue ? ` [${defaultValue}]` : ' [blank = same origin]'}: `);
        const next = await lines.next();
        const answer = next.done ? '' : next.value; // end of input counts as a blank answer
        if (answer.trim() === '') return { value: defaultValue, source: 'prompt' };
        const value = validate(answer);
        if (value !== null) return { value, source: 'prompt' };
        output.write(`  "${answer.trim()}" is not an http(s) address. Try again, e.g. https://api.example.com\n`);
      }
      throw new Error(`${name}: no valid value given.`);
    } finally {
      rl.close();
    }
  }

  return { value: defaultValue, source: 'default' };
}
