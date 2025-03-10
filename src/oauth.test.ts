import { afterEach, beforeEach, describe, it } from "node:test";
import type { TestContext } from "node:test";

import app from "./index";
import type * as Schema from "./schema";

import { cleanDatabase } from "../tests/helpers";
import {
  createAccount,
  createOAuthApplication,
  getAccessGrant,
  getApplication,
  getLastAccessGrant,
  getLastAccessToken,
} from "../tests/helpers/oauth";
import { getLoginCookie } from "../tests/helpers/web";
import { OOB_REDIRECT_URI } from "./oauth/constants";
import { createAccessGrant } from "./oauth/helpers";

describe("OAuth", () => {
  it(
    "Can GET /.well-known/oauth-authorization-server",
    { plan: 10 },
    async (t: TestContext) => {
      // We use the full URL in this test as the route calculates values based
      // on the Host header
      const response = await app.request(
        "http://localhost:3000/.well-known/oauth-authorization-server",
        {
          method: "GET",
        },
      );

      t.assert.equal(response.status, 200, "Should return 200-ok");

      const metadata = await response.json();

      t.assert.equal(metadata.issuer, "http://localhost:3000/");
      t.assert.equal(
        metadata.authorization_endpoint,
        "http://localhost:3000/oauth/authorize",
      );
      t.assert.equal(
        metadata.token_endpoint,
        "http://localhost:3000/oauth/token",
      );
      // Non-standard, mastodon extension:
      t.assert.equal(
        metadata.app_registration_endpoint,
        "http://localhost:3000/api/v1/apps",
      );

      t.assert.deepStrictEqual(metadata.response_types_supported, ["code"]);
      t.assert.deepStrictEqual(metadata.response_modes_supported, ["query"]);
      t.assert.deepStrictEqual(metadata.grant_types_supported, [
        "authorization_code",
        "client_credentials",
      ]);
      t.assert.deepStrictEqual(metadata.token_endpoint_auth_methods_supported, [
        "client_secret_post",
      ]);

      t.assert.ok(
        Array.isArray(metadata.scopes_supported),
        "Should return an array of scopes supported",
      );
    },
  );
});

describe("OAuth / POST /oauth/authorize", () => {
  let application: Schema.Application;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  const APP_REDIRECT_URI = "custom://oauth_callback";

  beforeEach(async () => {
    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:accounts"],
      redirectUris: [OOB_REDIRECT_URI, APP_REDIRECT_URI],
    });
    application = await getApplication(client);
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  it(
    "Does not create an access grant if denied",
    { plan: 2 },
    async (t: TestContext) => {
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

      t.assert.equal(response.status, 302);
      t.assert.equal(
        response.headers.get("Location"),
        "custom://oauth_callback?error=access_denied&error_description=The+resource+owner+or+authorization+server+denied+the+request.",
      );
    },
  );

  it(
    "Can return authorization code out-of-bounds",
    { plan: 8 },
    async (t: TestContext) => {
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

      t.assert.equal(response.status, 200);
      t.assert.match(response.headers.get("content-type") ?? "", /text\/html/);

      const responseBody = await response.text();
      const lastAccessGrant = await getLastAccessGrant();

      t.assert.equal(lastAccessGrant.applicationId, application.id);
      t.assert.equal(lastAccessGrant.resourceOwnerId, account.id);
      t.assert.equal(lastAccessGrant.redirectUri, OOB_REDIRECT_URI);
      t.assert.deepStrictEqual(lastAccessGrant.scopes, ["read:accounts"]);
      t.assert.strictEqual(lastAccessGrant.revoked, null);

      t.assert.match(
        responseBody,
        new RegExp(`${lastAccessGrant.code}`),
        "Response should contain the access grant code",
      );
    },
  );

  it(
    "Can return authorization code via redirect",
    { plan: 7 },
    async (t: TestContext) => {
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

      t.assert.equal(response.status, 302);

      const lastAccessGrant = await getLastAccessGrant();
      t.assert.equal(lastAccessGrant.applicationId, application.id);
      t.assert.equal(lastAccessGrant.resourceOwnerId, account.id);
      t.assert.equal(lastAccessGrant.redirectUri, APP_REDIRECT_URI);
      t.assert.deepStrictEqual(lastAccessGrant.scopes, ["read:accounts"]);
      t.assert.strictEqual(lastAccessGrant.revoked, null);

      t.assert.equal(
        response.headers.get("Location"),
        `${APP_REDIRECT_URI}?code=${lastAccessGrant.code}&state=test_state_value`,
      );
    },
  );
});

describe("OAuth / POST /oauth/token", () => {
  let application: Schema.Application;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:accounts"],
      redirectUris: [OOB_REDIRECT_URI],
    });
    application = await getApplication(client);
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  it(
    "Can request a client credentials access token",
    { plan: 7 },
    async (t: TestContext) => {
      const body = new FormData();
      body.set("grant_type", "client_credentials");
      body.set("client_id", application.clientId);
      body.set("client_secret", application.clientSecret);
      body.set("scope", "read:accounts");

      const response = await app.request("/oauth/token", {
        method: "POST",
        body,
      });

      t.assert.equal(response.status, 200);
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const responseBody = await response.json();
      const lastAccessToken = await getLastAccessToken();

      t.assert.equal(lastAccessToken.grant_type, "client_credentials");
      t.assert.deepStrictEqual(lastAccessToken.scopes, ["read:accounts"]);
      t.assert.equal(
        responseBody.access_token,
        lastAccessToken.code,
        "Generates an Access Token",
      );
      t.assert.equal(responseBody.token_type, "Bearer");
      t.assert.equal(responseBody.scope, lastAccessToken.scopes.join(" "));
    },
  );

  it(
    "Can exchange an access grant for an access token",
    { plan: 8 },
    async (t: TestContext) => {
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

      t.assert.equal(response.status, 200);
      t.assert.equal(response.headers.get("content-type"), "application/json");

      const responseBody = await response.json();

      const lastAccessToken = await getLastAccessToken();
      const changedAccessGrant = await getAccessGrant(accessGrant.code);

      t.assert.notEqual(
        changedAccessGrant.revoked,
        null,
        "Successfully revokes the access grant",
      );
      t.assert.equal(lastAccessToken.grant_type, "authorization_code");
      t.assert.deepStrictEqual(
        lastAccessToken.scopes,
        changedAccessGrant.scopes,
      );

      t.assert.equal(
        responseBody.access_token,
        lastAccessToken.code,
        "Generates an Access Token",
      );
      t.assert.equal(responseBody.token_type, "Bearer");
      t.assert.equal(responseBody.scope, lastAccessToken.scopes.join(" "));
    },
  );
});
