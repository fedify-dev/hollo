import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
  type Token,
} from "../../tests/helpers/oauth";
import app from "../index";

describe("Mastodon compatibility stub endpoints", { concurrent: false }, () => {
  let readAccountsToken: Token;
  let readSearchToken: Token;

  beforeEach(async () => {
    await cleanDatabase();

    const account = await createAccount();
    const client = await createOAuthApplication({
      scopes: ["read:accounts", "read:search"],
    });
    readAccountsToken = await getAccessToken(client, account, [
      "read:accounts",
    ]);
    readSearchToken = await getAccessToken(client, account, ["read:search"]);
  });

  it.each([
    "/api/v1/trends",
    "/api/v1/trends/tags",
    "/api/v1/trends/statuses?offset=0",
    "/api/v1/trends/links",
  ])("returns an empty array for GET %s", async (path) => {
    expect.assertions(3);

    const response = await app.request(path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual([]);
  });

  it.each(["/api/v1/suggestions", "/api/v2/suggestions"])(
    "requires authentication for GET %s",
    async (path) => {
      expect.assertions(2);

      const response = await app.request(path);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    },
  );

  it.each(["/api/v1/suggestions", "/api/v2/suggestions"])(
    "rejects insufficient scope for GET %s",
    async (path) => {
      expect.assertions(2);

      const response = await app.request(path, {
        headers: {
          authorization: bearerAuthorization(readSearchToken),
        },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "insufficient_scope" });
    },
  );

  it.each(["/api/v1/suggestions", "/api/v2/suggestions"])(
    "returns an empty array for GET %s",
    async (path) => {
      expect.assertions(3);

      const response = await app.request(path, {
        headers: {
          authorization: bearerAuthorization(readAccountsToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual([]);
    },
  );
});
