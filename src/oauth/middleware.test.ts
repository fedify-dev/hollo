import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
  getApplication,
} from "../../tests/helpers/oauth";
import type * as Schema from "../schema";
import { createClientCredential } from "./helpers";
import { scopeRequired, tokenRequired, type Variables } from "./middleware";

describe.sequential("OAuth / Middleware", () => {
  describe.sequential("tokenRequired", () => {
    const app = new Hono<{ Variables: Variables }>();

    app.get("/tokenRequired", tokenRequired, (c) => {
      const token = c.get("token");
      const authorizationHeader = c.req.header("Authorization");
      return c.json({
        ...token,
        authorizationHeader,
      });
    });

    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;

    beforeEach(async () => {
      await cleanDatabase();

      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
      });
      application = await getApplication(client);
    });

    it("Can use a client credentials token", async () => {
      expect.assertions(7);

      const clientCredential = await createClientCredential(application, [
        "read:accounts",
      ]);

      const response = await app.request("/tokenRequired", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientCredential.token}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();

      expect(json.authorizationHeader).toBe(`Bearer ${clientCredential.token}`);
      expect(json.grant_type).toBe("client_credentials");
      expect(json.application.clientId).toBe(application.clientId);
      expect(json.scopes).toEqual(application.scopes);
      // A client credential grant should not have an account owner
      expect(json.accountOwner).toBeNull();
    });

    it("Can use an access token", async () => {
      expect.assertions(8);

      const accessToken = await getAccessToken(client, account, [
        "read:accounts",
      ]);

      const response = await app.request("/tokenRequired", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();

      expect(json.authorizationHeader).toBe(`Bearer ${accessToken.token}`);
      expect(json.grant_type).toBe("authorization_code");
      expect(json.applicationId).toBe(application.id);
      expect(json.accountOwnerId).toBe(account.id);
      expect(json.application.clientId).toBe(application.clientId);
      expect(json.scopes).toEqual(application.scopes);
    });

    it("Returns an error if the client credentials token is not valid", async () => {
      expect.assertions(3);

      const response = await app.request("/tokenRequired", {
        method: "GET",
        headers: {
          // Forces the client credentials code path:
          Authorization: "Bearer foobar",
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();

      expect(json.error).toBe("invalid_token");
    });

    it("Returns an error if the access token is not valid", async () => {
      expect.assertions(3);

      const response = await app.request("/tokenRequired", {
        method: "GET",
        headers: {
          // Forces the Access Token code path:
          Authorization: "Bearer foo^bar",
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();

      expect(json.error).toBe("invalid_token");
    });

    it("Returns an error if Authorization header is not Bearer type", async () => {
      expect.assertions(3);

      const response = await app.request("/tokenRequired", {
        method: "GET",
        headers: {
          Authorization: "Foo bar",
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();

      expect(json.error).toBe("unauthorized");
    });

    it("Returns an error if Authorization header is not present", async () => {
      expect.assertions(3);

      const response = await app.request("/tokenRequired", {
        method: "GET",
        headers: {
          /* deliberately no Authorization header */
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();

      expect(json.error).toBe("unauthorized");
    });
  });

  describe.sequential("scopeRequired", () => {
    const app = new Hono<{ Variables: Variables }>();

    app.get("/read", tokenRequired, scopeRequired(["read"]), (c) => {
      const token = c.get("token");
      const header = c.req.header("Authorization");
      return c.json({ ...token, header });
    });

    app.get(
      "/read-blocks",
      tokenRequired,
      scopeRequired(["read:blocks"]),
      (c) => {
        const token = c.get("token");
        const authorizationHeader = c.req.header("Authorization");
        return c.json({
          ...token,
          authorizationHeader,
        });
      },
    );

    app.get("/follow", tokenRequired, scopeRequired(["follow"]), (c) => {
      const token = c.get("token");
      const authorizationHeader = c.req.header("Authorization");
      return c.json({
        ...token,
        authorizationHeader,
      });
    });

    beforeEach(async () => {
      await cleanDatabase();
    });

    it("handles requiring read scope", async () => {
      expect.assertions(2);

      const client = await createOAuthApplication({
        scopes: ["read"],
      });
      const application = await getApplication(client);

      const clientCredential = await createClientCredential(application, [
        "read",
      ]);

      const response = await app.request("/read", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientCredential.token}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
    });

    it("handles requiring read:blocks scope", async () => {
      expect.assertions(2);

      const client = await createOAuthApplication({
        scopes: ["read:blocks"],
      });
      const application = await getApplication(client);

      const clientCredential = await createClientCredential(application, [
        "read:blocks",
      ]);

      const response = await app.request("/read-blocks", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientCredential.token}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
    });

    it("handles requiring read:blocks scope when using read scope", async () => {
      expect.assertions(2);

      const client = await createOAuthApplication({
        scopes: ["read"],
      });
      const application = await getApplication(client);

      const clientCredential = await createClientCredential(application, [
        "read",
      ]);

      const response = await app.request("/read-blocks", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientCredential.token}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
    });

    it("handles requiring read:blocks scope when using follow scope", async () => {
      expect.assertions(2);

      const client = await createOAuthApplication({
        scopes: ["follow"],
      });
      const application = await getApplication(client);

      const clientCredential = await createClientCredential(application, [
        "follow",
      ]);

      const response = await app.request("/read-blocks", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientCredential.token}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
    });
  });
});
