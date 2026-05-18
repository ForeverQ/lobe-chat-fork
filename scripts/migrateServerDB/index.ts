import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { migrate as neonMigrate } from 'drizzle-orm/neon-serverless/migrator';
import { migrate as nodeMigrate } from 'drizzle-orm/node-postgres/migrator';

// @ts-ignore tsgo handle esm import cjs and compatibility issues
import { DB_FAIL_INIT_HINT, DUPLICATE_EMAIL_HINT, PGVECTOR_HINT } from './errorHint';

// Load environment variables in priority order:
// 1. .env (lowest priority)
// 2. .env.[env] (medium priority, overrides .env)
// 3. .env.[env].local (highest priority, overrides previous)
// Use dotenv-expand to support ${var} variable expansion
const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config()); // Load .env
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` })); // Load .env.[env] and override
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` })); // Load .env.[env].local and override

const migrationsFolder = join(__dirname, '../../packages/database/migrations');

const transientMigrationErrorCodes = new Set(['40P01']);
const maxMigrationAttempts = 3;

const getPostgresErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return;

  const errorWithCode = error as { cause?: unknown; code?: unknown };

  if (typeof errorWithCode.code === 'string') return errorWithCode.code;

  return getPostgresErrorCode(errorWithCode.cause);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const prepareMigrationsFolder = async () => {
  const { BASIC_SEARCH_MIGRATION_TAGS, shouldUseBasicSearch } = await import(
    '../../packages/database/src/utils/searchMode'
  );

  if (!shouldUseBasicSearch()) return migrationsFolder;

  const temporaryFolder = await mkdtemp(join(tmpdir(), 'lobe-migrations-'));
  await cp(migrationsFolder, temporaryFolder, { recursive: true });

  for (const tag of BASIC_SEARCH_MIGRATION_TAGS) {
    await rm(join(temporaryFolder, `${tag}.sql`), { force: true });
  }

  const journalPath = join(temporaryFolder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };

  journal.entries = journal.entries.filter((entry) => !BASIC_SEARCH_MIGRATION_TAGS.has(entry.tag));
  await writeFile(journalPath, JSON.stringify(journal, null, 2));

  console.info('ℹ️ basic database search enabled; skipped pg_search/BM25 migrations');

  return temporaryFolder;
};

const migrateDatabase = async () => {
  const { serverDB } = await import('../../packages/database/src/server');
  const resolvedMigrationsFolder = await prepareMigrationsFolder();

  if (process.env.DATABASE_DRIVER === 'node') {
    await nodeMigrate(serverDB, { migrationsFolder: resolvedMigrationsFolder });
  } else {
    await neonMigrate(serverDB, { migrationsFolder: resolvedMigrationsFolder });
  }
};

const runMigrations = async () => {
  const time = Date.now();

  for (let attempt = 1; attempt <= maxMigrationAttempts; attempt++) {
    try {
      await migrateDatabase();
      break;
    } catch (error) {
      const errorCode = getPostgresErrorCode(error);
      const canRetry =
        errorCode && transientMigrationErrorCodes.has(errorCode) && attempt < maxMigrationAttempts;

      if (!canRetry) throw error;

      const delay = attempt * 5000;
      console.warn(
        '⚠️ database migration hit transient PostgreSQL error %s, retrying in %s ms (%s/%s)',
        errorCode,
        delay,
        attempt,
        maxMigrationAttempts,
      );
      await wait(delay);
    }
  }

  console.log('✅ database migration pass. use: %s ms', Date.now() - time);

  process.exit(0);
};

const connectionString = process.env.DATABASE_URL;

// only migrate database if the connection string is available
if (connectionString) {
  runMigrations().catch((err) => {
    console.error('❌ Database migrate failed:', err);

    const errMsg = err.message as string;

    const constraint = (err as { constraint?: string })?.constraint;

    if (errMsg.includes('extension "vector" is not available')) {
      console.info(PGVECTOR_HINT);
    } else if (constraint === 'users_email_unique' || errMsg.includes('users_email_unique')) {
      console.info(DUPLICATE_EMAIL_HINT);
    } else if (errMsg.includes(`Cannot read properties of undefined (reading 'migrate')`)) {
      console.info(DB_FAIL_INIT_HINT);
    }

    process.exit(1);
  });
} else {
  console.log('🟢 not find database env or in desktop mode, migration skipped');
}
