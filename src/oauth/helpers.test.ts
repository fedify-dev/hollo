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
  createAccessGrant,
  generatePKCECodeVerifier,
  getAccessToken,
  revokeAccessToken,
  revokeAccessTokenByCode,
  revokeApplicationAccess,
} from "./helpers";

describe("OAuth Helpers", () => {
  describe("generatePKCECodeVerifier", () => {
    it("returns a URL safe string", () => {
      const codeVerifier = generatePKCECodeVerifier();
      expect(codeVerifier).toMatch(URL_SAFE_REGEXP);
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
        where: { code: { eq: token } },
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

  describe("token revocation", () => {
    beforeEach(async () => {
      await cleanDatabase();
    });

    describe("revokeAccessTokenByCode", () => {
      it("revokes the token belonging to the given application", async () => {
        expect.assertions(2);

        const account = await createAccount();
        const client = await createOAuthApplication({ scopes: ["read"] });
        const accessToken = await oauthHelpers.getAccessToken(client, account, [
          "read",
        ]);

        const revoked = await revokeAccessTokenByCode(
          accessToken.token,
          client.id,
        );

        expect(revoked).toBe(1);
        expect(
          await oauthHelpers.findAccessToken(accessToken.token),
        ).toBeUndefined();
      });

      it("leaves a token belonging to another application alone", async () => {
        // This scoping is what stops one OAuth client from revoking another
        // client's tokens through POST /oauth/revoke.
        expect.assertions(2);

        const account = await createAccount();
        const client = await createOAuthApplication({ scopes: ["read"] });
        const other = await createOAuthApplication({ scopes: ["read"] });
        const accessToken = await oauthHelpers.getAccessToken(client, account, [
          "read",
        ]);

        const revoked = await revokeAccessTokenByCode(
          accessToken.token,
          other.id,
        );

        expect(revoked).toBe(0);
        expect(
          await oauthHelpers.findAccessToken(accessToken.token),
        ).toBeDefined();
      });
    });

    describe("revokeAccessToken", () => {
      it("revokes the token with the given surrogate id", async () => {
        expect.assertions(3);

        const account = await createAccount();
        const client = await createOAuthApplication({ scopes: ["read"] });
        const doomed = await oauthHelpers.getAccessToken(client, account, [
          "read",
        ]);
        const survivor = await oauthHelpers.getAccessToken(client, account, [
          "read",
        ]);
        const stored = await oauthHelpers.findAccessToken(doomed.token);

        const revoked = await revokeAccessToken(stored!.id);

        expect(revoked).toBe(1);
        expect(
          await oauthHelpers.findAccessToken(doomed.token),
        ).toBeUndefined();
        expect(
          await oauthHelpers.findAccessToken(survivor.token),
        ).toBeDefined();
      });

      it("reports zero when no token has that id", async () => {
        expect.assertions(1);

        const revoked = await revokeAccessToken(crypto.randomUUID());

        expect(revoked).toBe(0);
      });
    });

    describe("revokeApplicationAccess", () => {
      it("revokes every token of the application and no others", async () => {
        expect.assertions(4);

        const account = await createAccount();
        const target = await createOAuthApplication({
          scopes: ["read"],
          confidential: true,
        });
        const other = await createOAuthApplication({ scopes: ["read"] });
        const first = await oauthHelpers.getAccessToken(target, account, [
          "read",
        ]);
        const second = await oauthHelpers.getClientCredentialToken(target, [
          "read",
        ]);
        const untouched = await oauthHelpers.getAccessToken(other, account, [
          "read",
        ]);

        const revoked = await revokeApplicationAccess(target.id);

        expect(revoked).toBe(2);
        expect(await oauthHelpers.findAccessToken(first.token)).toBeUndefined();
        expect(
          await oauthHelpers.findAccessToken(second.token),
        ).toBeUndefined();
        expect(
          await oauthHelpers.findAccessToken(untouched.token),
        ).toBeDefined();
      });

      it("marks the application's pending access grants as revoked", async () => {
        expect.assertions(2);

        const account = await createAccount();
        const client = await createOAuthApplication({ scopes: ["read"] });
        const { code } = await createAccessGrant(
          client.id,
          account.id,
          ["read"],
          "urn:ietf:wg:oauth:2.0:oob",
        );
        expect((await oauthHelpers.findAccessGrant(code)).revoked).toBeNull();

        await revokeApplicationAccess(client.id);

        expect(
          (await oauthHelpers.findAccessGrant(code)).revoked,
        ).not.toBeNull();
      });
    });
  });
});
