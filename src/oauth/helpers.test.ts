import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../tests/helpers";
import * as oauthHelpers from "../../tests/helpers/oauth";
import {
  createAccount,
  createOAuthApplication,
} from "../../tests/helpers/oauth";
import db from "../db";
import { URL_SAFE_REGEXP } from "../helpers";
import * as schema from "../schema";
import {
  calculatePKCECodeChallenge,
  generatePKCECodeVerifier,
  getAccessToken,
} from "./helpers";

describe("OAuth Helpers", () => {
  describe("generatePKCECodeVerifier", () => {
    it("returns a URL safe string", () => {
      const codeVerifier = generatePKCECodeVerifier();
      expect(codeVerifier).to.match(URL_SAFE_REGEXP);
    });
  });

  describe("calculatePKCECodeChallenge", () => {
    it("should not throw any errors", async () => {
      expect.assertions(1);
      expect(async () => {
        await calculatePKCECodeChallenge("testtest");
      }).not.toThrow();
    });

    it("should return a URL safe string", async () => {
      expect.assertions(1);

      const code = await calculatePKCECodeChallenge("testtest");

      expect(code).toBe("NyaDNd1pMQRb3N-SYj_4GaZCRLU9DnRtQ4eXNJ1NpXg");
    });
  });

  describe("getAccessToken", async () => {
    let accessToken:
      | (schema.AccessToken & {
          application: schema.Application;
          accountOwner:
            | (schema.AccountOwner & {
                account: schema.Account & { successor: schema.Account | null };
              })
            | null;
        })
      | undefined;

    beforeEach(async () => {
      await cleanDatabase();

      const account = await createAccount();
      const client = await createOAuthApplication({
        scopes: ["read:accounts"],
      });
      const { token } = await oauthHelpers.getAccessToken(client, account);
      accessToken = await db.query.accessTokens.findFirst({
        where: eq(schema.accessTokens.code, token),
        with: {
          accountOwner: { with: { account: { with: { successor: true } } } },
          application: true,
        },
      });
    });

    const app = new Hono();
    app.get("/", async (c) => {
      const token = await getAccessToken(c);
      return c.json({ token });
    });

    it("should return an AccessToken object if token is provided", async () => {
      expect.assertions(3);

      expect(accessToken).toBeDefined();
      const response = await app.request("/", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken?.code}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        // To convert the Date objects inside the tree to ISO 8601 strings,
        // round-trip the object through JSON:
        token: JSON.parse(JSON.stringify(accessToken)),
      });
    });

    it("should return undefined if no Authorization header is provided", async () => {
      expect.assertions(2);

      const response = await app.request("/", { method: "GET" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    });

    it("should return null if Authorization header contains an invalid token", async () => {
      expect.assertions(2);

      const response = await app.request("/", {
        method: "GET",
        headers: { Authorization: "Bearer INVALID" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: null });
    });
  });
});
