import type { AnyColumn, SQL } from 'drizzle-orm';
import { or, sql } from 'drizzle-orm';

import type { LobeChatDatabase } from '../type';

export const BASIC_SEARCH_MIGRATION_TAGS = new Set([
  '0090_enable_pg_search',
  '0093_add_bm25_indexes_with_icu',
]);

const BASIC_SEARCH_MODES = new Set(['basic', 'disabled', 'neon']);
const BM25_SEARCH_MODES = new Set(['bm25', 'paradedb', 'pg_search']);

export const escapeLikePattern = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

export const buildContainsCondition = (column: unknown, q?: string) => {
  const normalized = q?.trim();
  if (!normalized) return undefined;

  return sql<boolean>`${column} ILIKE ${`%${escapeLikePattern(normalized)}%`} ESCAPE '\\'`;
};

export const buildAnyContainsCondition = (columns: unknown[], q?: string): SQL | undefined => {
  const conditions = columns
    .map((column) => buildContainsCondition(column, q))
    .filter((condition): condition is SQL<boolean> => Boolean(condition));

  return conditions.length > 0 ? or(...conditions) : undefined;
};

export const buildJsonbTextContainsCondition = (column: unknown, q?: string) => {
  const normalized = q?.trim();
  if (!normalized) return undefined;

  return sql<boolean>`${column}::text ILIKE ${`%${escapeLikePattern(normalized)}%`} ESCAPE '\\'`;
};

export const getDatabaseSearchMode = () => process.env.DATABASE_SEARCH_MODE?.trim().toLowerCase();

export const isNeonDatabaseUrl = (databaseUrl = process.env.DATABASE_URL) => {
  if (!databaseUrl) return false;

  try {
    return new URL(databaseUrl).hostname.includes('neon.tech');
  } catch {
    return databaseUrl.includes('neon.tech');
  }
};

export const shouldUseBasicSearch = () => {
  const mode = getDatabaseSearchMode();

  if (mode && BASIC_SEARCH_MODES.has(mode)) return true;
  if (mode && BM25_SEARCH_MODES.has(mode)) return false;

  return isNeonDatabaseUrl();
};

export const shouldUseBm25Search = () => !shouldUseBasicSearch();

export const isPGliteDatabase = (db: LobeChatDatabase) => {
  const client = (
    db as unknown as {
      $client?: {
        dataDir?: unknown;
        waitReady?: unknown;
      };
    }
  ).$client;

  return 'waitReady' in (client ?? {}) && 'dataDir' in (client ?? {});
};

export const databaseSupportsBm25Search = (db: LobeChatDatabase) =>
  shouldUseBm25Search() && !isPGliteDatabase(db);

export interface Bm25MatchFieldGroup {
  fallbackColumns: unknown[];
  fields: string[];
  keyColumn: AnyColumn;
}

export const buildSearchCondition = (params: {
  bm25MatchQuery: string;
  groups: Bm25MatchFieldGroup[];
  normalizedQuery: string;
  supportsBm25: boolean;
}) => {
  const { bm25MatchQuery, groups, normalizedQuery, supportsBm25 } = params;

  if (!normalizedQuery) return undefined;

  const conditions = supportsBm25
    ? groups
        .map(({ fields, keyColumn }) => {
          if (fields.length === 0) return undefined;

          const matchQueries = fields.map(
            (field) => sql`paradedb.match(${field}, ${bm25MatchQuery}, conjunction_mode => true)`,
          );

          return sql<boolean>`${keyColumn} @@@ paradedb.boolean(should => ARRAY[${sql.join(matchQueries, sql`, `)}])`;
        })
        .filter((condition): condition is SQL<boolean> => Boolean(condition))
    : groups
        .flatMap(({ fallbackColumns }) => fallbackColumns)
        .map((column) => buildContainsCondition(column, normalizedQuery))
        .filter((condition): condition is SQL<boolean> => Boolean(condition));

  return conditions.length > 0 ? or(...conditions) : undefined;
};
