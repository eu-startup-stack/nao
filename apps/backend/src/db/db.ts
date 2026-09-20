import type { Database as Sqlite } from 'bun:sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { EnhancedQueryLogger } from 'drizzle-query-logger';
import postgres from 'postgres';

import { env } from '../env';
import dbConfig, { Dialect } from './dbConfig';
import * as pgSchema from './pg-schema';
import * as sqliteSchema from './sqlite-schema';

const logger = env.DB_QUERY_LOGGING ? new EnhancedQueryLogger() : undefined;

// bun:sqlite and drizzle-orm/bun-sqlite are Bun-only builtins that Node's ESM
// resolver has never heard of. Importing them as static VALUE imports (as
// this module used to) makes Node throw ERR_UNSUPPORTED_ESM_URL_SCHEME at
// boot, even when DB_URI selects Postgres, because ESM imports are eager.
// Loading them dynamically, only from inside the SQLite branch, defers
// resolution until the SQLite dialect is actually selected -- the same
// pattern already used correctly by this file's sibling, readonly-app-db.ts.
async function createSqliteDb() {
	const { Database } = await import('bun:sqlite');
	const { drizzle: drizzleBunSqlite } = await import('drizzle-orm/bun-sqlite');
	const sqlite = new Database(dbConfig.dbUrl);
	sqlite.run('PRAGMA foreign_keys = ON;');
	return drizzleBunSqlite(sqlite, { schema: sqliteSchema, logger });
}

async function createDb() {
	if (dbConfig.dialect === Dialect.Postgres) {
		const ssl = env.DB_SSL ? 'require' : undefined;
		const sql = postgres(dbConfig.dbUrl, { ssl });
		return drizzlePostgres(sql, { schema: pgSchema, logger });
	} else {
		return createSqliteDb();
	}
}

export const db = (await createDb()) as BunSQLiteDatabase<typeof sqliteSchema> & {
	$client: Sqlite;
};

export type DBTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DBExecutor = typeof db | DBTransaction;
