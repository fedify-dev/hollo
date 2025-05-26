import { parseHTML } from "linkedom";
import * as timekeeper from "timekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "./index";
import type * as Schema from "./schema";
import { scopeEnum } from "./schema";

import { cleanDatabase } from "../tests/helpers";
import {
  basicAuthorization,
  createAccount,
  createOAuthApplication,
  findAccessGrant,
  findAccessToken,
  getAccessToken,
  getApplication,
  getLastAccessGrant,
  getLastAccessToken,
  revokeAccessGrant,
} from "../tests/helpers/oauth";
import { getLoginCookie } from "../tests/helpers/web";
import { OOB_REDIRECT_URI } from "./oauth/constants";
import {
  calculatePKCECodeChallenge,
  createAccessGrant,
  generatePKCECodeVerifier,
} from "./oauth/helpers";

async function getPage(response: Response) {
  const text = await response.text();
  const { document } = parseHTML(text);

  return document;
}

describe.sequential("OAuth", () => {
  afterEach(async () => {
    await cleanDatabase();
  });

  it("Can GET /.well-known/oauth-authorization-server", async () => {
    expect.assertions(12);
    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request(
      "http://localhost:3000/.well-known/oauth-authorization-server",
      {
        method: "GET",
      },
    );

    expect(response.status).toBe(200);

    const metadata = await response.json();

    expect(metadata.issuer).toBe("http://localhost:3000/");
    expect(metadata.authorization_endpoint).toBe(
      "http://localhost:3000/oauth/authorize",
    );
    expect(metadata.token_endpoint).toBe("http://localhost:3000/oauth/token");
    expect(metadata.revocation_endpoint).toBe(
      "http://localhost:3000/oauth/revoke",
    );
    // Non-standard, mastodon extension:
    expect(metadata.app_registration_endpoint).toBe(
      "http://localhost:3000/api/v1/apps",
    );

    expect(metadata.response_types_supported).toEqual(["code"]);
    expect(metadata.response_modes_supported).toEqual(["query"]);
    expect(metadata.grant_types_supported).toEqual([
      "authorization_code",
      "client_credentials",
    ]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_post",
      "client_secret_basic",
    ]);

    expect(Array.isArray(metadata.scopes_supported)).toBeTruthy();
    expect(metadata.scopes_supported).toEqual(scopeEnum.enumValues);
  });

  describe.sequential("GET /oauth/authorize", () => {
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;

    beforeEach(async () => {
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

      expect(form.getAttribute("action"), "/oauth/authorize");

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

      expect(form.getAttribute("action"), "/oauth/authorize");

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

      expect(form.getAttribute("action"), "/oauth/authorize");

      expect(
        form.querySelector("input[name=redirect_uri]")?.getAttribute("value"),
      ).toBe("http://app.example/");

      // Test the buttons, as we're using OOB there's no deny button:
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

      expect(form.getAttribute("action"), "/oauth/authorize");

      const listedScopes = Array.from(
        page.querySelectorAll("#scopes > li > code"),
      ).map((scopeElement) => scopeElement.textContent);

      expect(listedScopes).toEqual(["read"]);

      expect(
        form.querySelector("input[name=scopes]")?.getAttribute("value"),
      ).toBe("read");
    });

    it("successfully displays an authorization page with state", async () => {
      expect.assertions(9);

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

      expect(form.getAttribute("action"), "/oauth/authorize");

      expect(
        form.querySelector("input[name=redirect_uri]")?.getAttribute("value"),
      ).toBe("http://app.example/");

      expect(
        form.querySelector("input[name=state]")?.getAttribute("value"),
      ).toBe(state);

      // Test the buttons, as we're using OOB there's no deny button:
      const buttons = form.querySelectorAll("button[name=decision]");
      expect(buttons.length).toBe(2);
      expect(buttons[0].getAttribute("value")).toBe("deny");
      expect(buttons[1].getAttribute("value")).toBe("allow");
    });

    it("successfully displays an authorization page with PKCE fields", async () => {
      expect.assertions(10);

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

      expect(form.getAttribute("action"), "/oauth/authorize");

      expect(
        form.querySelector("input[name=redirect_uri]")?.getAttribute("value"),
      ).toBe("http://app.example/");

      expect(
        form.querySelector("input[name=code_challenge]")?.getAttribute("value"),
      ).toBe(codeChallenge);
      expect(
        form
          .querySelector("input[name=code_challenge_method]")
          ?.getAttribute("value"),
      ).toBe("S256");

      // Test the buttons, as we're using OOB there's no deny button:
      const buttons = form.querySelectorAll("button[name=decision]");
      expect(buttons.length).toBe(2);
      expect(buttons[0].getAttribute("value")).toBe("deny");
      expect(buttons[1].getAttribute("value")).toBe("allow");
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
  });

  describe.sequential("POST /oauth/authorize", () => {
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;
    const APP_REDIRECT_URI = "custom://oauth_callback";

    beforeEach(async () => {
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
      expect.assertions(1);

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
  });

  describe.sequential("POST /oauth/token PKCE", () => {
    let account: Awaited<ReturnType<typeof createAccount>>;
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;

    beforeEach(async () => {
      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: true,
      });
      application = await getApplication(client);
    });

    afterEach(async () => {
      await cleanDatabase();
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

    afterEach(async () => {
      vi.useRealTimers();
      await cleanDatabase();
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

    it("cannot request an access token using multiple client authentication methods", async () => {
      expect.assertions(3);
      // Here we are using both client_secret_post and client_secret_basic
      // together, which is not acceptable

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
      });

      afterEach(() => {
        timekeeper.reset();
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

    // Invalid request
    it("cannot use unknown parameters", async () => {
      expect.assertions(4);
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("redirect_uri", OOB_REDIRECT_URI);

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
      expect(responseBody.error).toBe("invalid_request");
    });
  });

  describe.sequential("POST /oauth/token (Public Client)", () => {
    let application: Schema.Application;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let account: Awaited<ReturnType<typeof createAccount>>;

    beforeEach(async () => {
      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: false,
      });
      application = await getApplication(client);
    });

    afterEach(async () => {
      await cleanDatabase();
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

  describe.sequential("POST /oauth/revoke", () => {
    let account: Awaited<ReturnType<typeof createAccount>>;
    let client: Awaited<ReturnType<typeof createOAuthApplication>>;
    let application: Schema.Application;
    let wrongClient: Awaited<ReturnType<typeof createOAuthApplication>>;
    let wrongApplication: Schema.Application;

    beforeEach(async () => {
      account = await createAccount();
      client = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: true,
      });
      application = await getApplication(client);

      wrongClient = await createOAuthApplication({
        scopes: ["read:accounts"],
        redirectUris: [OOB_REDIRECT_URI],
        confidential: true,
      });
      wrongApplication = await getApplication(wrongClient);
    });

    afterEach(async () => {
      await cleanDatabase();
    });

    it("can revoke an access token using client_secret_basic", async () => {
      expect.assertions(4);
      const accessToken = await getAccessToken(client, account);
      const body = new FormData();
      body.set("token", accessToken.token);

      const response = await app.request("/oauth/revoke", {
        method: "POST",
        headers: {
          authorization: basicAuthorization(application),
        },
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const accessTokenAfterRevocation = await findAccessToken(
        accessToken.token,
      );

      expect(accessTokenAfterRevocation).toBe(undefined);
    });

    it("can revoke an access token using client_secret_post", async () => {
      expect.assertions(4);
      const accessToken = await getAccessToken(client, account);
      const body = new FormData();
      body.set("token", accessToken.token);
      body.set("client_id", application.clientId);
      body.set("client_secret", application.clientSecret);

      const response = await app.request("/oauth/revoke", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const accessTokenAfterRevocation = await findAccessToken(
        accessToken.token,
      );

      expect(accessTokenAfterRevocation).toBe(undefined);
    });

    it("cannot revoke an access token for a different client, but does not return any errors", async () => {
      expect.assertions(4);
      const accessToken = await getAccessToken(client, account);
      const body = new FormData();
      body.set("token", accessToken.token);
      body.set("client_id", wrongApplication.clientId);
      body.set("client_secret", wrongApplication.clientSecret);

      const response = await app.request("/oauth/revoke", {
        method: "POST",
        body,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const accessTokenAfterRevocation = await findAccessToken(
        accessToken.token,
      );

      expect(accessTokenAfterRevocation).not.toBe(undefined);
    });

    it("cannot revoke a token using token_type_hint of refresh_token", async () => {
      expect.assertions(5);
      const body = new FormData();
      body.set("token", "123");
      body.set("token_type_hint", "refresh_token");

      const response = await app.request("/oauth/revoke", {
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

      expect(typeof responseBody).toBe("object");
      expect(responseBody.error).toBe("unsupported_token_type");
    });

    it("cannot revoke a token without supplying the token parameter", async () => {
      expect.assertions(5);
      const body = new FormData();
      // explicitly doesn't have `token`
      body.set("token_type_hint", "refresh_token");

      const response = await app.request("/oauth/revoke", {
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

      expect(typeof responseBody).toBe("object");
      expect(responseBody.error).toBe("invalid_request");
    });
  });
});
