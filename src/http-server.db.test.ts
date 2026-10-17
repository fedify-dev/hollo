import { request as httpRequest } from "node:http";

import { Hono } from "hono";
import postgres from "postgres";
import { expect, it } from "vitest";

import {
  isPostgresQueryCancelError,
  postgresQueryCancellationMiddleware,
  wrapPostgresClient,
} from "./db-cancel";
import { createHttpServer } from "./http-server";

it("cancels an active SQL query when the HTTP client disconnects", async () => {
  const applicationName = `hollo-http-cancel-${crypto.randomUUID()}`;
  const client = wrapPostgresClient(
    postgres(process.env.DATABASE_URL!, {
      max: 1,
      connection: { application_name: applicationName },
    }),
  );
  const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
  const cancelled = Promise.withResolvers<unknown>();
  const app = new Hono();
  // Match Hollo: let the cancellation middleware normalize a query error.
  app.onError((error) => {
    throw error;
  });
  app.use(postgresQueryCancellationMiddleware());
  app.get("/", async (c) => {
    try {
      await client.unsafe("select pg_sleep(30)");
      return c.text("finished");
    } catch (error) {
      cancelled.resolve(error);
      throw error;
    }
  });
  const server = createHttpServer(app.fetch, {
    port: 0,
    hostname: "127.0.0.1",
    behindProxy: true,
  });
  await server.ready();
  const request = httpRequest(server.url!, {
    headers: { "X-Forwarded-Proto": "https" },
    agent: false,
  });
  request.on("error", () => {});
  try {
    request.end();
    // Observe execution, rather than racing disconnect against lazy SQL dispatch.
    await expect
      .poll(async () => {
        const rows = await observer`
          select 1 from pg_stat_activity
          where application_name = ${applicationName} and state = 'active'
        `;
        return rows.length;
      })
      .toBe(1);
    request.destroy();
    expect(isPostgresQueryCancelError(await cancelled.promise)).toBe(true);
  } finally {
    request.destroy();
    await server.close(true);
    await Promise.all([
      client.end({ timeout: 1 }),
      observer.end({ timeout: 1 }),
    ]);
  }
});
