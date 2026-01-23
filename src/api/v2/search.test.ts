import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";

import app from "../../index";

describe.sequential("/api/v2/search", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount({ generateKeyPair: true });
    client = await createOAuthApplication({
      scopes: ["read:search", "write"],
    });
    accessToken = await getAccessToken(client, account, [
      "read:search",
      "write",
    ]);
  });

  describe("limit parameter", () => {
    it("returns results respecting the limit parameter", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=5", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(5);
      expect(json.statuses.length).toBeLessThanOrEqual(5);
    });

    it("caps limit at 40 when a higher value is provided", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=100", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(40);
      expect(json.statuses.length).toBeLessThanOrEqual(40);
    });

    it("uses default limit of 20 when not specified", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(20);
      expect(json.statuses.length).toBeLessThanOrEqual(20);
    });

    it("handles limit of 1 correctly", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=1", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(1);
      expect(json.statuses.length).toBeLessThanOrEqual(1);
    });

    it("treats limit of 0 as 1 (minimum limit)", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=0", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(1);
      expect(json.statuses.length).toBeLessThanOrEqual(1);
    });
  });

  describe("authentication", () => {
    it("returns 401 when no access token is provided", async () => {
      expect.assertions(2);

      const response = await app.request("/api/v2/search?q=test", {
        method: "GET",
      });

      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error).toBe("unauthorized");
    });
  });
});
