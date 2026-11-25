import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import mariadb from 'mariadb';
import { applyTestEnv, TEST_DB } from './env.js';

/** Creates the test database if needed and brings it to the latest migration. */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const url = new URL(process.env.DATABASE_URL!);

  const conn = await mariadb.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    allowPublicKeyRetrieval: true,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }

  // Run the CLI through node directly: spawning npx/.cmd needs a shell on Windows.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });
}
