import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env on its own. The repo keeps a single .env at the root.
const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
