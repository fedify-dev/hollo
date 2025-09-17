import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before } from "node:test";
import { sql } from "drizzle-orm";

import db from "../src/db";
import { drive } from "../src/storage";

const fixtureFiles = join(import.meta.dirname, "fixtures", "files");

export async function getFixtureFile(
  name: string,
  type: string,
): Promise<File> {
  const filePath = join(fixtureFiles, name);
  const data = await readFile(filePath);

  return new File([new Uint8Array(data)], name, {
    type,
  });
}

export async function cleanDatabase() {
  const schema = "public";
  const tables = await db.execute<Record<"table_name", string>>(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_type = 'BASE TABLE';`,
  );

  const tableExpression = tables
    .map((table) => {
      return [`"${schema}"`, `"${table.table_name}"`].join(".");
    })
    .join(", ");

  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tableExpression} RESTART IDENTITY CASCADE`),
  );
}

before(async () => {
  await cleanDatabase();
});

// Automatically close the database and remove test file uploads
// Without this the tests hang due to the database
after(async () => {
  await db.$client.end({ timeout: 5 });

  const disk = drive.fake();
  await disk.deleteAll();
});
