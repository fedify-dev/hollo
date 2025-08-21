import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../../tests/helpers";
import {
  basicAuthorization,
  createAccount,
  createOAuthApplication,
  findAccessToken,
  getAccessToken,
  getApplication,
} from "../../../tests/helpers/oauth";

import type * as Schema from "../../schema";

import { OOB_REDIRECT_URI } from "../constants";
import revokeEndpoint from "./revoke";

describe.sequential("POST /oauth/revoke", () => {
  let account: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let application: Schema.Application;
  let wrongClient: Awaited<ReturnType<typeof createOAuthApplication>>;
  let wrongApplication: Schema.Application;

  const app = new Hono();
  app.route("/oauth/revoke", revokeEndpoint);

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
      scopes: ["read:accounts"],
      redirectUris: [OOB_REDIRECT_URI],
      confidential: true,
    });
    wrongApplication = await getApplication(wrongClient);
  });

  it("can revoke an access token using client_secret_basic", async () => {
    expect.assertions(3);
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

    const accessTokenAfterRevocation = await findAccessToken(accessToken.token);

    expect(accessTokenAfterRevocation).toBe(undefined);
  });

  it("can revoke an access token using client_secret_post", async () => {
    expect.assertions(3);
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

    const accessTokenAfterRevocation = await findAccessToken(accessToken.token);

    expect(accessTokenAfterRevocation).toBe(undefined);
  });

  it("cannot revoke an access token for a different client, but does not return any errors", async () => {
    expect.assertions(3);
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

    const accessTokenAfterRevocation = await findAccessToken(accessToken.token);

    expect(accessTokenAfterRevocation).not.toBe(undefined);
  });

  it("cannot revoke a token using token_type_hint of refresh_token", async () => {
    expect.assertions(4);
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

    const responseBody = await response.json();

    expect(typeof responseBody).toBe("object");
    expect(responseBody.error).toBe("unsupported_token_type");
  });

  it("cannot revoke a token without supplying the token parameter", async () => {
    expect.assertions(4);
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

    const responseBody = await response.json();

    expect(typeof responseBody).toBe("object");
    expect(responseBody.error).toBe("invalid_request");
  });
});
