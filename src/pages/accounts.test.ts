import { describe, expect, it } from "vitest";

import { parseFields } from "./accounts";

describe("parseFields", () => {
  it("preserves custom field values longer than 255 characters", () => {
    const form = new FormData();
    const longValue = `[${"example ".repeat(40)}](https://example.com)`;

    form.set("fields[0][name]", "Links");
    form.set("fields[0][value]", ` ${longValue} `);

    expect(parseFields(form)).toEqual([{ name: "Links", value: longValue }]);
  });

  it("keeps custom field labels limited to 255 characters", () => {
    const form = new FormData();

    form.set("fields[0][name]", "A".repeat(300));
    form.set("fields[0][value]", "https://example.com");

    expect(parseFields(form)).toEqual([
      { name: "A".repeat(255), value: "https://example.com" },
    ]);
  });
});

it("commits import batches before dispatch", async () => {
  const { Hono } = await import("hono");
  const { vi } = await import("vitest");
  const { cleanDatabase } = await import("../../tests/helpers");
  const { createAccount } = await import("../../tests/helpers/oauth");
  const { getLoginCookie } = await import("../../tests/helpers/web");
  const { default: db } = await import("../db");
  const { importJobs, importJobItems } = await import("../schema");
  const { backgroundJobs } = await import("../federation/federation");
  const { default: accounts } = await import("./accounts");
  await cleanDatabase();
  const owner = await createAccount();
  const app = new Hono();
  app.route("/accounts", accounts);
  const dispatch = vi
    .spyOn(backgroundJobs, "enqueueJob")
    .mockImplementation(async () => {
      expect(await db.select().from(importJobs)).toHaveLength(1);
      expect(await db.select().from(importJobItems)).toHaveLength(1001);
    });
  try {
    const form = new FormData();
    form.set("category", "muted_accounts");
    form.set(
      "file",
      new File(
        [
          "Account address,Hide notifications\n" +
            Array.from(
              { length: 1001 },
              (_, index) => `test${index},true`,
            ).join("\n"),
        ],
        "mutes.csv",
        { type: "text/csv" },
      ),
    );
    const response = await app.request(`/accounts/${owner.id}/migrate/import`, {
      method: "POST",
      body: form,
      headers: { Cookie: await getLoginCookie(), Origin: "http://localhost" },
    });
    expect(response.status).toBe(302);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    dispatch.mockRestore();
  }
});

it("rolls back the parent and first batch when a later import batch fails", async () => {
  const { Hono } = await import("hono");
  const { sql } = await import("drizzle-orm");
  const { cleanDatabase } = await import("../../tests/helpers");
  const { createAccount } = await import("../../tests/helpers/oauth");
  const { getLoginCookie } = await import("../../tests/helpers/web");
  const { default: db } = await import("../db");
  const { importJobs, importJobItems } = await import("../schema");
  const { default: accounts } = await import("./accounts");
  await cleanDatabase();
  const owner = await createAccount();
  await db.execute(
    sql.raw(
      `CREATE FUNCTION test_import_batch_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data->>'handle' = 'broken' THEN RAISE EXCEPTION 'test batch failure'; END IF; RETURN NEW; END $$`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER test_import_batch_failure BEFORE INSERT ON import_job_items FOR EACH ROW EXECUTE FUNCTION test_import_batch_failure()`,
    ),
  );
  try {
    const app = new Hono();
    app.route("/accounts", accounts);
    const form = new FormData();
    form.set("category", "muted_accounts");
    form.set(
      "file",
      new File(
        [
          "Account address,Hide notifications\n" +
            Array.from(
              { length: 1000 },
              (_, index) => `test${index},true`,
            ).join("\n") +
            "\nbroken,true",
        ],
        "mutes.csv",
        { type: "text/csv" },
      ),
    );
    const response = await app.request(`/accounts/${owner.id}/migrate/import`, {
      method: "POST",
      body: form,
      headers: { Cookie: await getLoginCookie(), Origin: "http://localhost" },
    });
    expect(response.status).toBe(500);
    expect(await db.select().from(importJobs)).toHaveLength(0);
    expect(await db.select().from(importJobItems)).toHaveLength(0);
  } finally {
    await db.execute(
      sql.raw(`DROP TRIGGER test_import_batch_failure ON import_job_items`),
    );
    await db.execute(sql.raw(`DROP FUNCTION test_import_batch_failure()`));
  }
});
