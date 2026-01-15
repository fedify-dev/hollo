import { getLogger } from "@logtape/drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import {
  drizzle,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import createPostgres from "postgres";
import * as schema from "./schema";

// biome-ignore lint/complexity/useLiteralKeys: tsc rants about this (TS4111)
const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl == null) throw new Error("DATABASE_URL must be defined");

export const postgres = createPostgres(databaseUrl, {
  connect_timeout: 5,
  connection: { IntervalStyle: "iso_8601" },
});
export const db = drizzle(postgres, { schema, logger: getLogger() });

export type Database = PgDatabase<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

// This is necessary for passing a transaction into a function:
export type Transaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export default db;
