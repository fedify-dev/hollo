import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import createPostgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = await readFile(
  new URL(
    "../drizzle/20260927104708_post-foreign-key-indexes/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const statements = migration.split("--> statement-breakpoint");
const indexes = [
  ["list_posts", "post_id"],
  ["timeline_posts", "post_id"],
  ["remote_reply_scrape_jobs", "post_id"],
  ["notifications", "target_post_id"],
  ["notification_groups", "target_post_id"],
] as const;

describe("Post foreign-key index migration", () => {
  const client = createPostgres(process.env.DATABASE_URL!, { max: 1 });
  const schema = `post_indexes_${randomUUID().replaceAll("-", "")}`;

  beforeEach(async () => {
    await client`CREATE SCHEMA ${client(schema)}`;
    await client`SET search_path TO ${client(schema)}`;
    await client`CREATE TABLE posts (id uuid PRIMARY KEY)`;
    for (const [table, column] of indexes) {
      await client`CREATE TABLE ${client(table)} (
        ${client(column)} uuid REFERENCES posts(id) ON DELETE CASCADE,
        other_id uuid
      )`;
    }
  });

  afterEach(async () => {
    await client`SET search_path TO public`;
    await client`DROP SCHEMA IF EXISTS ${client(schema)} CASCADE`;
  });

  afterAll(async () => {
    await client.end();
  });

  async function applyMigration() {
    await client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
  }

  async function indexOids() {
    return await client<{ name: string; oid: number; valid: boolean }[]>`
      SELECT relation.relname AS name, relation.oid::int AS oid,
        idx.indisvalid AS valid
      FROM pg_catalog.pg_index AS idx
      JOIN pg_catalog.pg_class AS relation ON relation.oid = idx.indexrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${schema} AND relation.relname != 'posts_pkey'
      ORDER BY relation.relname
    `;
  }

  it("creates all five indexes and preserves cascading deletes", async () => {
    await applyMigration();
    const created = await indexOids();
    expect(created.map((index) => index.name)).toEqual(
      indexes.map(([table, column]) => `${table}_${column}_index`).sort(),
    );
    expect(created.every((index) => index.valid)).toBe(true);

    const postId = randomUUID();
    await client`INSERT INTO posts (id) VALUES (${postId})`;
    for (const [table, column] of indexes) {
      await client`INSERT INTO ${client(table)} (${client(column)}) VALUES (${postId})`;
    }
    await client`DELETE FROM posts WHERE id = ${postId}`;
    for (const [table] of indexes) {
      expect(await client`SELECT * FROM ${client(table)}`).toHaveLength(0);
    }
  });

  it("reuses valid indexes built concurrently and can run again", async () => {
    for (const [table, column] of indexes) {
      await client`CREATE INDEX CONCURRENTLY ${client(`${table}_${column}_index`)}
        ON ${client(table)} (${client(column)})`;
    }
    const existing = await indexOids();
    await applyMigration();
    await applyMigration();
    expect(await indexOids()).toEqual(existing);
  });

  it.each([
    ["wrong column", "ON list_posts (other_id)"],
    ["wrong table", "ON timeline_posts (post_id)"],
    ["partial index", "ON list_posts (post_id) WHERE post_id IS NOT NULL"],
    ["hash index", "ON list_posts USING hash (post_id)"],
    ["extra key", "ON list_posts (post_id, other_id)"],
    ["included column", "ON list_posts (post_id) INCLUDE (other_id)"],
  ])(
    "rejects an existing %s and rolls back new indexes",
    async (_, definition) => {
      await client.unsafe(
        `CREATE INDEX list_posts_post_id_index ${definition}`,
      );
      await expect(applyMigration()).rejects.toThrow(
        "list_posts_post_id_index is missing, invalid, or has an unexpected definition",
      );
      expect(await indexOids()).toHaveLength(1);
    },
  );

  it("rejects an existing unique index", async () => {
    await client`CREATE UNIQUE INDEX list_posts_post_id_index ON list_posts (post_id)`;
    await expect(applyMigration()).rejects.toThrow("unexpected definition");
  });

  it("rejects an invalid index left by a failed concurrent build", async () => {
    const writer = createPostgres(process.env.DATABASE_URL!, { max: 1 });
    const connection = await writer.reserve();
    try {
      await connection`BEGIN`;
      await connection`INSERT INTO ${connection(schema)}.list_posts DEFAULT VALUES`;
      // The concurrent build creates its catalog entry, then waits for this
      // writer before scanning the table.  Timing out leaves a non-unique,
      // otherwise matching index whose validity check alone must reject it.
      await client`SET statement_timeout TO '1s'`;
      try {
        await expect(
          client`CREATE INDEX CONCURRENTLY list_posts_post_id_index ON list_posts (post_id)`,
        ).rejects.toThrow("canceling statement due to statement timeout");
      } finally {
        await client`SET statement_timeout TO 0`;
      }
      expect((await indexOids())[0].valid).toBe(false);
      const [invalid] = await client`
        SELECT indisunique FROM pg_catalog.pg_index
        WHERE indexrelid = 'list_posts_post_id_index'::regclass
      `;
      expect(invalid.indisunique).toBe(false);

      // Building the missing timeline index would wait for this writer.
      // Preflight must reject the bad index before reaching that build.
      await connection`INSERT INTO ${connection(schema)}.timeline_posts DEFAULT VALUES`;
      await client`SET lock_timeout TO '200ms'`;
      try {
        await expect(applyMigration()).rejects.toThrow("invalid");
        expect(await indexOids()).toHaveLength(1);
      } finally {
        await client`SET lock_timeout TO 0`;
      }
    } finally {
      try {
        await connection`ROLLBACK`;
      } finally {
        connection.release();
        await writer.end();
      }
    }
  });
});
