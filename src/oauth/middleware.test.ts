import { afterEach, beforeEach, describe, it } from "node:test";
import type { TestContext } from "node:test";
import { Hono } from "hono";

import type * as Schema from "../schema";

import { cleanDatabase } from "../../tests/helpers";
import {
  createAccount,
  createOAuthApplication,
  getAccessToken,
  getApplication,
} from "../../tests/helpers/oauth";
import { createClientCredential } from "./helpers";
import { type Variables, tokenRequired } from "./middleware";

describe("OAuth / Middleware", () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/endpoint", tokenRequired, (c) => {
    const token = c.get("token");
    const header = c.req.header("Authorization");
    return c.json({ ...token, header });
  });

  let application: Schema.Application;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:accounts"],
    });
    application = await getApplication(client);
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  it(
    "Can use a client credentials token",
    { plan: 7 },
    async (t: TestContext) => {
      const clientCredential = await createClientCredential(application, [
        "read:accounts",
      ]);

      const response = await app.request("/endpoint", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientCredential.token}`,
        },
      });

      t.assert.equal(response.status, 200, "Should return 200");
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const json = await response.json();

      t.assert.equal(json.header, `Bearer ${clientCredential.token}`);
      t.assert.equal(json.grant_type, "client_credentials");
      t.assert.equal(json.application.clientId, application.clientId);
      t.assert.deepStrictEqual(json.scopes, application.scopes);
      t.assert.strictEqual(
        json.accountOwner,
        null,
        "A client credential grant should not have an account owner",
      );
    },
  );

  it("Can use an access token", { plan: 8 }, async (t: TestContext) => {
    const accessToken = await getAccessToken(client, account, [
      "read:accounts",
    ]);

    const response = await app.request("/endpoint", {
      method: "GET",
      headers: {
        Authorization: accessToken.authorizationHeader,
      },
    });

    t.assert.equal(response.status, 200, "Should return 200");
    t.assert.equal(response.headers.get("content-type"), "application/json");

    const json = await response.json();

    t.assert.equal(json.header, accessToken.authorizationHeader);
    t.assert.equal(json.grant_type, "authorization_code");
    t.assert.equal(json.applicationId, application.id);
    t.assert.equal(json.accountOwnerId, account.id);
    t.assert.equal(json.application.clientId, application.clientId);
    t.assert.deepStrictEqual(json.scopes, application.scopes);
  });

  it(
    "Returns an error if the client credentials token is not valid",
    { plan: 3 },
    async (t: TestContext) => {
      const response = await app.request("/endpoint", {
        method: "GET",
        headers: {
          // Forces the client credentials code path:
          Authorization: "Bearer foobar",
        },
      });

      t.assert.equal(response.status, 401, "Should return 401");
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const json = await response.json();

      t.assert.equal(json.error, "invalid_token");
    },
  );

  it(
    "Returns an error if the access token is not valid",
    { plan: 3 },
    async (t: TestContext) => {
      const response = await app.request("/endpoint", {
        method: "GET",
        headers: {
          // Forces the Access Token code path:
          Authorization: "Bearer foo^bar",
        },
      });

      t.assert.equal(response.status, 401, "Should return 401");
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const json = await response.json();

      t.assert.equal(json.error, "invalid_token");
    },
  );

  it(
    "Returns an error if Authorization header is not Bearer type",
    { plan: 3 },
    async (t: TestContext) => {
      const response = await app.request("/endpoint", {
        method: "GET",
        headers: {
          Authorization: "Foo bar",
        },
      });

      t.assert.equal(response.status, 401, "Should return 401");
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const json = await response.json();

      t.assert.equal(json.error, "unauthorized");
    },
  );

  it(
    "Returns an error if Authorization header is not present",
    { plan: 3 },
    async (t: TestContext) => {
      const response = await app.request("/endpoint", {
        method: "GET",
        headers: {
          /* deliberately no Authorization header */
        },
      });

      t.assert.equal(response.status, 401, "Should return 401");
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const json = await response.json();

      t.assert.equal(json.error, "unauthorized");
    },
  );
});
