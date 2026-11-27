import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEST_DB = 'notes_test';

/**
 * Points the process at an isolated database and switches off request throttling.
 * Secrets and host settings still come from the repo's .env so no extra setup is needed.
 */
export function applyTestEnv(): void {
  const rootEnv = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

  const base = new URL(process.env.DATABASE_URL ?? 'mysql://notes:notes@localhost:3306/notes');
  base.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = base.toString();
  process.env.NODE_ENV = 'test';
  process.env.THROTTLE_DISABLED = 'true';
  process.env.COLLAB_MIGRATE_ON_START = 'false';
  process.env.DATA_DIR = resolve(import.meta.dirname, '../.test-data');
}
