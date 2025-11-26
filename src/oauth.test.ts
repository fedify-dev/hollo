import { parseHTML } from "linkedom";
import * as timekeeper from "timekeeper";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../tests/helpers";
import {
  basicAuthorization,
  createAccount,
  createOAuthApplication,
  findAccessGrant,
  getApplication,
  getLastAccessGrant,
  getLastAccessToken,
  revokeAccessGrant,
} from "../tests/helpers/oauth";
import { getLoginCookie } from "../tests/helpers/web";
import app from "./index";
import { OOB_REDIRECT_URI } from "./oauth/constants";
import {
  calculatePKCECodeChallenge,
  createAccessGrant,
  generatePKCECodeVerifier,
} from "./oauth/helpers";
import type * as Schema from "./schema";

async function getPage(response: Response) {
  const text = await response.text();
  const { document } = parseHTML(text);

  return document;
}

describe.sequential("OAuth", () => {
  describe.sequential("GET /oauth/authorize", () => {
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;

    beforeEach(async () => {
      await cleanDatabase();

      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read", "read:accounts", "follow"],
        redirectUris: [OOB_REDIRECT_URI, "http://app.example/"],
        confidential: true,
      });
      application = await getApplication(client);
    });

    it("successfully displays an authorization page", async () => {
      expect.assertions(14);

      const cookie = await getLoginCookie();
      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", OOB_REDIRECT_URI);
      parameters.set("scope", "read:accounts follow");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const listedScopes = Array.from(
        page.querySelectorAll("#scopes > li > code"),
      ).map((scopeElement) => scopeElement.textContent);

      expect(listedScopes).toEqual(["read:accounts", "follow"]);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      const accountSelectors = Array.from(
        form.querySelectorAll("input[name=account_id]"),
      ).map((input) => input.getAttribute("value"));

      expect(accountSelectors).toEqual([account.id]);

      expect(
        form.querySelector("input[name=application_id]")?.getAttribute("value"),
      ).toBe(application.id);

      expect(
        form.querySelector("input[name=redirect_uri]")?.getAttribute("value"),
      ).toBe(OOB_REDIRECT_URI);

      expect(
        form.querySelector("input[name=scopes]")?.getAttribute("value"),
      ).toBe("read:accounts follow");

      // We didn't pass state, code_challenge, or code_challenge_method
      expect(form.querySelector("input[name=state]")).toBeNull();
      expect(form.querySelector("input[name=code_challenge]")).toBeNull();
      expect(
        form.querySelector("input[name=code_challenge_method]"),
      ).toBeNull();

      // Test the buttons, as we're using OOB there's no deny button:
      const buttons = form.querySelectorAll("button[name=decision]");
      expect(buttons.length).toBe(1);
      expect(buttons[0].getAttribute("value")).toBe("allow");
    });

    it("successfully displays an authorization page with multiple accounts", async () => {
      expect.assertions(5);

      const secondaryAccount = await createAccount({ username: "secondary" });

      const cookie = await getLoginCookie();
      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", OOB_REDIRECT_URI);
      parameters.set("scope", "read:accounts follow");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      const accountSelectors = Array.from(
        form.querySelectorAll("input[name=account_id]"),
      ).map((input) => input.getAttribute("value"));

      expect(accountSelectors).toEqual([account.id, secondaryAccount.id]);
    });

    it("successfully displays an authorization page with external redirect_uri", async () => {
      expect.assertions(8);

      const cookie = await getLoginCookie();
      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", "http://app.example/");
      parameters.set("scope", "read:accounts follow");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      expect(
        form.querySelector("input[name=redirect_uri]")?.getAttribute("value"),
      ).toBe("http://app.example/");

      // Test the buttons, as we're using an external redirect_uri there are
      // deny and allow buttons:
      const buttons = form.querySelectorAll("button[name=decision]");
      expect(buttons.length).toBe(2);
      expect(buttons[0].getAttribute("value")).toBe("deny");
      expect(buttons[1].getAttribute("value")).toBe("allow");
    });

    it("successfully displays an authorization page without scope", async () => {
      expect.assertions(6);

      const cookie = await getLoginCookie();
      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", OOB_REDIRECT_URI);
      // no scope parameter

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      const listedScopes = Array.from(
        page.querySelectorAll("#scopes > li > code"),
      ).map((scopeElement) => scopeElement.textContent);

      expect(listedScopes).toEqual(["read"]);

      expect(
        form.querySelector("input[name=scopes]")?.getAttribute("value"),
      ).toBe("read");
    });

    it("successfully displays an authorization page with state", async () => {
      expect.assertions(5);

      const cookie = await getLoginCookie();
      const state = crypto.randomUUID();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("state", state);
      parameters.set("redirect_uri", "http://app.example/");
      parameters.set("scope", "read:accounts follow");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      expect(
        form.querySelector("input[name=state]")?.getAttribute("value"),
      ).toBe(state);
    });

    it("successfully displays an authorization page with PKCE fields", async () => {
      expect.assertions(6);

      const cookie = await getLoginCookie();
      const codeVerifier = generatePKCECodeVerifier();
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("code_challenge", codeChallenge);
      parameters.set("code_challenge_method", "S256");
      parameters.set("redirect_uri", "http://app.example/");
      parameters.set("scope", "read:accounts follow");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      expect(
        form.querySelector("input[name=code_challenge]")?.getAttribute("value"),
      ).toBe(codeChallenge);
      expect(
        form
          .querySelector("input[name=code_challenge_method]")
          ?.getAttribute("value"),
      ).toBe("S256");
    });

    it("successfully displays an authorization page without redirect_uri (uses default)", async () => {
      expect.assertions(5);

      const cookie = await getLoginCookie();
      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("scope", "read:accounts follow");
      // Deliberately not setting redirect_uri - should use the first one in the list

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);

      const page = await getPage(response);

      const form = page.querySelector("form[method='post']");
      expect(form).not.toBeNull();

      if (!form) {
        throw new Error("Invariant error: form was not null but not found");
      }

      expect(form.getAttribute("action")).toEqual("/oauth/authorize");

      // Should default to the first redirect_uri in the list (OOB_REDIRECT_URI)
      expect(
        form.querySelector("input[name=redirect_uri]")?.getAttribute("value"),
      ).toBe(OOB_REDIRECT_URI);
    });

    it("returns an error with invalid client_id", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", "invalid");
      parameters.set("redirect_uri", "http://app.example/");
      parameters.set("scope", "read:accounts follow");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toMatchObject({
        error: "invalid_client_id",
      });
    });

    it("returns an error with invalid client_id", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", "http://app.example/");
      parameters.set("scope", "write:accounts");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toMatchObject({
        error: "invalid_scope",
      });
    });

    it("returns an error with invalid redirect_uri", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", "http://invalid.example/");
      parameters.set("scope", "read:accounts");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toMatchObject({
        error: "invalid_redirect_uri",
      });
    });

    it("returns an error with missing PKCE method", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", OOB_REDIRECT_URI);
      parameters.set("code_challenge", "123");
      // explicitly no code_challenge_method
      parameters.set("scope", "read:accounts");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toMatchObject({
        error: "invalid_request",
      });
    });

    it("returns an error with missing PKCE value", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", OOB_REDIRECT_URI);
      // explicitly no code_challenge
      parameters.set("code_challenge_method", "S256");
      parameters.set("scope", "read:accounts");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toMatchObject({
        error: "invalid_request",
      });
    });

    it("returns an error with incorrect PKCE code_challenge_method", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();

      const parameters = new URLSearchParams();

      parameters.set("response_type", "code");
      parameters.set("client_id", application.clientId);
      parameters.set("redirect_uri", OOB_REDIRECT_URI);
      parameters.set("code_challenge", "test");
      parameters.set("code_challenge_method", "unknown");
      parameters.set("scope", "read:accounts");

      const response = await app.request(
        `/oauth/authorize?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Cookie: cookie,
          },
        },
      );

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toMatchObject({
        error: "invalid_request",
      });
    });
  });

  describe.sequential("POST /oauth/authorize", () => {
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;
    const APP_REDIRECT_URI = "custom://oauth_callback";

    beforeEach(async () => {
      await cleanDatabase();

      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI, APP_REDIRECT_URI],
        confidential: true,
      });
      application = await getApplication(client);
    });

    it("Does not create an access grant if denied", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", APP_REDIRECT_URI);
      formData.set("scopes", "read:accounts");
      formData.set("decision", "deny");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "custom://oauth_callback?error=access_denied&error_description=The+resource+owner+or+authorization+server+denied+the+request.",
      );
    });

    it("does not create an access grant if code_challenge is missing but code_challenge_method is set", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", APP_REDIRECT_URI);
      formData.set("scopes", "read:accounts");
      formData.set("code_challenge_method", "S256");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body).toMatchObject({
        error: "invalid_request",
      });
    });

    it("does not create an access grant if code_challenge_method is missing but code_challenge is set", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();
      const formData = new FormData();
      const codeVerifier = generatePKCECodeVerifier();
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", APP_REDIRECT_URI);
      formData.set("scopes", "read:accounts");
      formData.set("code_challenge", codeChallenge);
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body).toMatchObject({
        error: "invalid_request",
      });
    });

    it("Can return authorization code out-of-bounds", async () => {
      expect.assertions(8);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", OOB_REDIRECT_URI);
      formData.set("scopes", "read:accounts");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toMatch(/text\/html/);

      const responseBody = await response.text();
      const lastAccessGrant = await getLastAccessGrant();

      expect(lastAccessGrant.applicationId).toBe(application.id);
      expect(lastAccessGrant.resourceOwnerId).toBe(account.id);
      expect(lastAccessGrant.redirectUri).toBe(OOB_REDIRECT_URI);
      expect(lastAccessGrant.scopes).toEqual(["read:accounts"]);
      expect(lastAccessGrant.revoked).toBeNull();

      expect(responseBody).toMatch(new RegExp(`${lastAccessGrant.code}`));
    });

    it("Can return authorization code via redirect", async () => {
      expect.assertions(7);
      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", APP_REDIRECT_URI);
      formData.set("scopes", "read:accounts");
      formData.set("state", "test_state_value");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(302);

      const lastAccessGrant = await getLastAccessGrant();
      expect(lastAccessGrant.applicationId).toBe(application.id);
      expect(lastAccessGrant.resourceOwnerId).toBe(account.id);
      expect(lastAccessGrant.redirectUri).toBe(APP_REDIRECT_URI);
      expect(lastAccessGrant.scopes).toEqual(["read:accounts"]);
      expect(lastAccessGrant.revoked).toBeNull();

      expect(response.headers.get("Location")).toBe(
        `${APP_REDIRECT_URI}?code=${lastAccessGrant.code}&state=test_state_value`,
      );
    });

    it("returns an error if the application does not exist", async () => {
      expect.assertions(2);

      // This is an incredibly small chance, but just to make debugging this
      // failure case somewhat easier to debug:
      expect(application.id).not.toBe("403dafb4-9c37-4dfc-bfb4-02fb0cf681fb");

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", "403dafb4-9c37-4dfc-bfb4-02fb0cf681fb");
      formData.set("redirect_uri", OOB_REDIRECT_URI);
      // write:accounts is not a registered scope for the application:
      formData.set("scopes", "write:accounts");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(404);
    });

    it("returns an error if the account does not exist", async () => {
      expect.assertions(1);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", "403dafb4-9c37-4dfc-bfb4-02fb0cf681fb");
      formData.set("application_id", application.id);
      formData.set("redirect_uri", OOB_REDIRECT_URI);
      // write:accounts is not a registered scope for the application:
      formData.set("scopes", "write:accounts");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(404);
    });

    it("returns an error if the scopes does not match the application scopes", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", OOB_REDIRECT_URI);
      // write:accounts is not a registered scope for the application:
      formData.set("scopes", "write:accounts");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body).toMatchObject({
        error: "invalid_scope",
      });
    });

    it("returns an error if the redirect_uri does not match the application redirect URIs", async () => {
      expect.assertions(2);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      formData.set("redirect_uri", "https://invalid.example/");
      formData.set("scopes", "read:accounts");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(400);
      const body = await response.json();

      expect(body).toMatchObject({
        error: "invalid_redirect_uri",
      });
    });

    it("Can return authorization code without redirect_uri (uses default)", async () => {
      expect.assertions(7);

      const cookie = await getLoginCookie();
      const formData = new FormData();

      formData.set("account_id", account.id);
      formData.set("application_id", application.id);
      // Deliberately not setting redirect_uri - should use the first one in the list
      formData.set("scopes", "read:accounts");
      formData.set("decision", "allow");

      const response = await app.request("/oauth/authorize", {
        method: "POST",
        body: formData,
        headers: {
          Cookie: cookie,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toMatch(/text\/html/);

      await response.text();
      const lastAccessGrant = await getLastAccessGrant();

      expect(lastAccessGrant.applicationId).toBe(application.id);
      expect(lastAccessGrant.resourceOwnerId).toBe(account.id);
      // Should default to the first redirect_uri in the list (OOB_REDIRECT_URI)
      expect(lastAccessGrant.redirectUri).toBe(OOB_REDIRECT_URI);
      expect(lastAccessGrant.scopes).toEqual(["read:accounts"]);
      expect(lastAccessGrant.revoked).toBeNull();
    });
  });

  describe.sequential("POST /oauth/token PKCE", () => {
    let account: Awaited<ReturnType<typeof createAccount>>;
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;

    beforeEach(async () => {
      await cleanDatabase();

      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: true,
      });
      application = await getApplication(client);
    });

    it("can exchange an access grant for an access token using PKCE", async () => {
      expect.assertions(8);

      const codeVerifier = generatePKCECodeVerifier();
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
      const codeChallengeMethod = "S256";

      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
        codeChallenge,
        codeChallengeMethod,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);
      body.set("code_verifier", codeVerifier);

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      const lastAccessToken = await getLastAccessToken();
      const changedAccessGrant = await findAccessGrant(accessGrant.code);

      expect(changedAccessGrant.revoked).not.toBeNull();
      expect(lastAccessToken.grant_type).toBe("authorization_code");
      expect(lastAccessToken.scopes).toEqual(changedAccessGrant.scopes);

      expect(responseBody.access_token).toBe(lastAccessToken.code);
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe(lastAccessToken.scopes.join(" "));
    });

    it("cannot exchange an access grant for an access token using invalid verifier", async () => {
      expect.assertions(4);

      const codeVerifier = generatePKCECodeVerifier();
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
      const codeChallengeMethod = "S256";

      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
        codeChallenge,
        codeChallengeMethod,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);
      body.set("code_verifier", "invalid");

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      expect(responseBody.error).toBe("invalid_grant");

      const changedAccessGrant = await findAccessGrant(accessGrant.code);

      expect(changedAccessGrant.revoked).toBeNull();
    });

    it("cannot exchange an access grant for an access token using without verifier", async () => {
      expect.assertions(4);

      const codeVerifier = generatePKCECodeVerifier();
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
      const codeChallengeMethod = "S256";

      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
        codeChallenge,
        codeChallengeMethod,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);
      // explicitly no code_verifier property

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      expect(responseBody.error).toBe("invalid_grant");

      const changedAccessGrant = await findAccessGrant(accessGrant.code);

      expect(changedAccessGrant.revoked).toBeNull();
    });
  });

  describe.sequential("POST /oauth/token (Confidential Client)", () => {
    let account: Awaited<ReturnType<typeof createAccount>>;
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let wrongApplication: Schema.Application;
    let wrongClient: Awaited<ReturnType<typeof createOAuthApplication>>;

    beforeEach(async () => {
      await cleanDatabase();

      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: true,
      });
      application = await getApplication(client);

      wrongClient = await createOAuthApplication({
        scopes: ["write:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: true,
      });
      wrongApplication = await getApplication(wrongClient);
    });

    it("cannot request an access token without using a client authentication method", async () => {
      expect.assertions(3);
      // Here we are deliberately not using any client authentication method,
      // which is not acceptable

      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();
      expect(responseBody.error).toBe("invalid_client");
    });

    it("allows multiple client authentication methods with same credentials", async () => {
      expect.assertions(5);
      // Some clients (like tooot) send credentials via both Basic auth and POST body.
      // This should be allowed if the credentials are the same.

      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("client_id", application.clientId);
      body.set("client_secret", application.clientSecret);
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();
      expect(responseBody.access_token).toBeDefined();
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe("read:accounts");
    });

    it("cannot request an access token using multiple client authentication methods with different credentials", async () => {
      expect.assertions(3);
      // Using different credentials for Basic auth and POST body should fail

      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("client_id", wrongApplication.clientId);
      body.set("client_secret", wrongApplication.clientSecret);
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();
      expect(responseBody.error).toBe("invalid_request");
    });

    it("cannot request an access token using invalid client authentication", async () => {
      expect.assertions(3);
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("client_id", application.clientId);
      body.set("client_secret", "invalid");
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();
      expect(responseBody.error).toBe("invalid_client");
    });

    // Client Credentials Grant Flow
    it("can request an access token using the client credentials grant flow with client_secret_basic", async () => {
      expect.assertions(7);
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();
      const lastAccessToken = await getLastAccessToken();

      expect(lastAccessToken.grant_type).toBe("client_credentials");
      expect(lastAccessToken.scopes).toEqual(["read:accounts"]);
      expect(responseBody.access_token).toBe(lastAccessToken.code);
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe(lastAccessToken.scopes.join(" "));
    });

    it("can request an access token using the client credentials grant flow with client_secret_post", async () => {
      expect.assertions(7);
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("client_id", application.clientId);
      body.set("client_secret", application.clientSecret);
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();
      const lastAccessToken = await getLastAccessToken();

      expect(lastAccessToken.grant_type).toBe("client_credentials");
      expect(lastAccessToken.scopes).toEqual(["read:accounts"]);
      expect(responseBody.access_token).toBe(lastAccessToken.code);
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe(lastAccessToken.scopes.join(" "));
    });

    it("can request an access token using the client credentials grant flow using JSON body", async () => {
      expect.assertions(7);
      const body = JSON.stringify({
        grant_type: "client_credentials",
        client_id: application.clientId,
        client_secret: application.clientSecret,
        scope: "read:accounts",
      });

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const lastAccessToken = await getLastAccessToken();
      const responseBody = await response.json();

      expect(lastAccessToken.grant_type).toBe("client_credentials");
      expect(lastAccessToken.scopes).toEqual(["read:accounts"]);
      expect(responseBody.access_token).toBe(lastAccessToken.code);
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe(lastAccessToken.scopes.join(" "));
    });

    it("cannot request client credentials grant flow with scope not registered to the application", async () => {
      expect.assertions(4);
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("scope", "write:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const responseBody = await response.json();
      expect(responseBody.error).toBe("invalid_scope");
    });

    // OAuth Authorization Code Grant Flow
    it("can exchange an access grant for an access token", async () => {
      expect.assertions(8);
      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      const lastAccessToken = await getLastAccessToken();
      const changedAccessGrant = await findAccessGrant(accessGrant.code);

      expect(changedAccessGrant.revoked).not.toBeNull();
      expect(lastAccessToken.grant_type).toBe("authorization_code");
      expect(lastAccessToken.scopes).toEqual(changedAccessGrant.scopes);

      expect(responseBody.access_token).toBe(lastAccessToken.code);
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe(lastAccessToken.scopes.join(" "));
    });

    describe.sequential("expired access grants", () => {
      beforeEach(() => {
        timekeeper.freeze();

        return () => {
          timekeeper.reset();
        };
      });

      it("cannot exchange an access grant for an access token when the access grant has expired", async () => {
        expect.assertions(3);

        const accessGrant = await createAccessGrant(
          application.id,
          account.id,
          ["read:accounts"],
          OOB_REDIRECT_URI,
        );

        timekeeper.travel(accessGrant.expiry.valueOf() + 1000);

        const body = new FormData();
        body.set("grant_type", "authorization_code");
        body.set("client_id", application.clientId);
        // client_secret is technically optional, but we don't support public clients yet:
        body.set("client_secret", application.clientSecret);
        body.set("redirect_uri", OOB_REDIRECT_URI);
        body.set("code", accessGrant.code);

        const response = await app.request("/oauth/token", {
          method: "POST",
          body,
        });

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toBe("application/json");

        const responseBody = await response.json();

        expect(responseBody.error).toBe("invalid_grant");
      });
    });

    it("cannot exchange an access grant for an access token when the redirect URI does not match", async () => {
      expect.assertions(3);
      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", "https://invalid.example/");
      body.set("code", accessGrant.code);

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      expect(responseBody.error).toBe("invalid_grant");
    });

    it("cannot exchange an access grant for an access token when the client does not match", async () => {
      expect.assertions(3);
      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", wrongApplication.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", wrongApplication.clientSecret);
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      expect(responseBody.error).toBe("invalid_grant");
    });

    it("cannot exchange an access grant for an access token when the access grant is revoked", async () => {
      expect.assertions(3);
      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
      );

      await revokeAccessGrant(accessGrant);

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("client_id", application.clientId);
      // client_secret is technically optional, but we don't support public clients yet:
      body.set("client_secret", application.clientSecret);
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      expect(responseBody.error).toBe("invalid_grant");
    });

    // Unsupported authorization grant flow:
    it("cannot use an unsupported grant_type", async () => {
      expect.assertions(5);
      const body = new FormData();
      body.set("grant_type", "invalid");

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      const responseBody = await response.json();

      expect(typeof responseBody).toBe("object");
      expect(Object.keys(responseBody)).toEqual(["error", "error_description"]);
      expect(responseBody.error).toBe("unsupported_grant_type");
    });

    it("can accept scope for authorization_code requests", async () => {
      expect.assertions(7);

      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);
      body.set("scope", "follow");

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const responseBody = await response.json();
      expect(typeof responseBody).toBe("object");
      expect(responseBody).toHaveProperty("access_token");
      expect(responseBody).toHaveProperty("created_at");
      expect(responseBody.scope).toBe("read:accounts");
      expect(responseBody.token_type).toBe("Bearer");
    });

    it("can accept redirect_uri for client_credentials requests", async () => {
      expect.assertions(7);

      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("scope", "read:accounts");
      body.set("redirect_uri", OOB_REDIRECT_URI);

      const response = await app.request("/oauth/token", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      // No redirection happens here, since redirect_uri is not used in
      // client_credentials flow, so we expect a 200 OK response:
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const responseBody = await response.json();
      expect(typeof responseBody).toBe("object");
      expect(responseBody).toHaveProperty("access_token");
      expect(responseBody).toHaveProperty("created_at");
      expect(responseBody.scope).toBe("read:accounts");
      expect(responseBody.token_type).toBe("Bearer");
    });
  });

  describe.sequential("POST /oauth/token (Public Client)", () => {
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;

    beforeEach(async () => {
      await cleanDatabase();

      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: false,
      });
      application = await getApplication(client);
    });

    it("can request an access token using the authorization code grant flow", async () => {
      expect.assertions(8);
      const accessGrant = await createAccessGrant(
        application.id,
        account.id,
        ["read:accounts"],
        OOB_REDIRECT_URI,
      );

      const body = new FormData();
      body.set("grant_type", "authorization_code");
      body.set("redirect_uri", OOB_REDIRECT_URI);
      body.set("code", accessGrant.code);

      const response = await app.request(
        `/oauth/token?client_id=${application.clientId}`,
        {
          method: "POST",
          body,
        },
      );

      const responseBody = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const lastAccessToken = await getLastAccessToken();
      const changedAccessGrant = await findAccessGrant(accessGrant.code);

      expect(changedAccessGrant.revoked).not.toBeNull();
      expect(lastAccessToken.grant_type).toBe("authorization_code");
      expect(lastAccessToken.scopes).toEqual(changedAccessGrant.scopes);

      expect(responseBody.access_token).toBe(lastAccessToken.code);
      expect(responseBody.token_type).toBe("Bearer");
      expect(responseBody.scope).toBe(lastAccessToken.scopes.join(" "));
    });

    it("cannot request an access token using the client credentials grant flow", async () => {
      expect.assertions(3);
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("scope", "read:accounts");

      const response = await app.request(
        `/oauth/token?client_id=${application.clientId}`,
        {
          method: "POST",
          body,
        },
      );

      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");

      expect(responseBody.error).toBe("unauthorized_client");
    });
  });
});
