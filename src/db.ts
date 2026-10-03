import { getLogger } from "@logtape/drizzle-orm";
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import createPostgres from "postgres";

import { wrapPostgresClient } from "./db-cancel";
import { relations } from "./relations";

// oxlint-disable-next-line typescript/dot-notation
const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl == null) throw new Error("DATABASE_URL must be defined");

export function createPostgresClient(
  max: number,
  options: Partial<createPostgres.Options<{}>> = {},
) {
  return wrapPostgresClient(
    createPostgres(databaseUrl!, {
      // The pool size needs to exceed the ParallelMessageQueue concurrency (10)
      // to leave headroom for HTTP handlers and KV store queries.  The default
      // of 10 can cause connection starvation under federation load.
      max,
      connect_timeout: 5,
      connection: { IntervalStyle: "iso_8601" },
      ...options,
    }),
  );
}

export const postgres = createPostgresClient(20);
export const db = drizzle({ client: postgres, relations, logger: getLogger() });

export type Database = PostgresJsDatabase<typeof relations>;

// This is necessary for passing a transaction into a function:
export type Transaction = PostgresJsTransaction<typeof relations>;

export type DatabaseLike = Database | Transaction;

export default db;
