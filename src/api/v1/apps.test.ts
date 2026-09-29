import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  countApplications,
  createAccount,
  createOAuthApplication,
  getAccessToken,
  getApplication,
  getClientCredentialToken,
  getLastApplication,
} from "../../../tests/helpers/oauth";
import { URL_SAFE_REGEXP } from "../../helpers";
import app from "../../index";
import { OOB_REDIRECT_URI } from "../../oauth/constants";
import type * as Schema from "../../schema";

describe("POST /api/v1/apps", { concurrent: false }, () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("successfully creates a confidential client using FormData (by default)", async () => {
    expect.assertions(13);

    const body = new FormData();
    body.append("scopes", "read:accounts");

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();
    const application = await getLastApplication();

    expect(application.clientId).toMatch(URL_SAFE_REGEXP);
    expect(application.clientSecret).toMatch(URL_SAFE_REGEXP);

    expect(typeof json).toBe("object");
    expect(json.id).toBe(application.id);
    expect(json.redirect_uris).toEqual(application.redirectUris);
    expect(json.redirect_uri).toBe(application.redirectUris.join(" "));
    // This is a placeholder for Application Client Secrets potentially expiring:
    expect(json.client_secret_expires_at).toBe(0);

    expect(application.redirectUris).toEqual([]);
    expect(application.scopes).toEqual(["read:accounts"]);
    expect(application.confidential).toBe(true);
  });

  it("successfully creates a confidential client without duplicate scopes", async () => {
    expect.assertions(7);
    const body = new FormData();
    body.append("scopes", "read:accounts read:accounts");

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const credentialApplication = await response.json();
    const application = await getLastApplication();

    expect(typeof credentialApplication).toBe("object");
    expect(credentialApplication.id).toBe(application.id);

    expect(application.scopes).toEqual(["read:accounts"]);
    expect(application.confidential).toBe(true);
  });

  it("successfully creates a confidential client using JSON (by default)", async () => {
    expect.assertions(12);
    const body = JSON.stringify({ scopes: "read:accounts" });

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();
    const application = await getLastApplication();

    expect(typeof json).toBe("object");
    expect(Object.keys(json)).toEqual([
      "id",
      "name",
      "website",
      "redirect_uris",
      "redirect_uri",
      "client_id",
      // Note: for public clients, this won't be present:
      "client_secret",
      "client_secret_expires_at",
      "vapid_key",
    ]);

    expect(json.id).toBe(application.id);
    expect(json.redirect_uris).toEqual(application.redirectUris);
    expect(json.redirect_uri).toBe(application.redirectUris.join(" "));

    // This is a placeholder for Application Client Secrets potentially expiring:
    expect(json.client_secret_expires_at).toBe(0);

    expect(application.redirectUris).toEqual([]);
    expect(application.scopes).toEqual(["read:accounts"]);
    expect(application.confidential).toBe(true);
  });

  it("successfully creates an application with read scope by default", async () => {
    expect.assertions(10);
    const body = new FormData();
    body.append("redirect_uris", OOB_REDIRECT_URI);

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const credentialApplication = await response.json();
    const application = await getLastApplication();

    expect(typeof credentialApplication).toBe("object");
    expect(credentialApplication.id).toBe(application.id);
    expect(credentialApplication.redirect_uris).toEqual(
      application.redirectUris,
    );
    expect(credentialApplication.redirect_uri).toBe(
      application.redirectUris.join(" "),
    );

    expect(application.redirectUris).toEqual([OOB_REDIRECT_URI]);
    expect(application.scopes).toEqual(["read"]);
    expect(application.confidential).toBe(true);
  });

  it("successfully creates an application with multiple redirect_uris", async () => {
    expect.assertions(10);
    const body = JSON.stringify({
      client_name: "Test: Multiple redirect URIs",
      redirect_uris: [
        "https://app.test/onboarding/connect",
        "https://app.test/oauth/callback",
      ],
    });

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const credentialApplication = await response.json();
    const application = await getLastApplication();

    expect(typeof credentialApplication).toBe("object");
    expect(credentialApplication.id).toBe(application.id);
    expect(credentialApplication.redirect_uris).toEqual(
      application.redirectUris,
    );
    expect(credentialApplication.redirect_uri).toBe(
      application.redirectUris.join(" "),
    );

    expect(application.redirectUris).toEqual([
      "https://app.test/onboarding/connect",
      "https://app.test/oauth/callback",
    ]);
    expect(application.scopes).toEqual(["read"]);
    expect(application.confidential).toBe(true);
  });

  // TODO: Support public clients
  it.skip("successfully creates a public client application", () => {});

  // Validation
  it("prevents creating an application with invalid scopes", async () => {
    expect.assertions(6);

    const prevAppCount = await countApplications();
    const body = new FormData();
    body.append("scopes", "invalid read:accounts");

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const error = await response.json();
    const appCount = await countApplications();

    expect(typeof error).toBe("object");
    expect(error.error).toBe("invalid_request");

    // Should not change the number of applications registered
    expect(appCount).toBe(prevAppCount);
  });

  it("prevents creating an application with invalid redirect_uris", async () => {
    expect.assertions(6);

    const prevAppCount = await countApplications();
    const body = new FormData();
    body.append("redirect_uris", "invalid");

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const error = await response.json();
    const appCount = await countApplications();

    expect(typeof error).toBe("object");
    expect(error.error).toBe("invalid_request");

    // Should not change the number of applications registered
    expect(appCount).toBe(prevAppCount);
  });

  it("prevents creating an application if any of the redirect_uris are invalid", async () => {
    expect.assertions(6);

    const prevAppCount = await countApplications();
    const body = JSON.stringify({
      redirect_uris: [OOB_REDIRECT_URI, "invalid"],
    });

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const error = await response.json();
    const appCount = await countApplications();

    expect(typeof error).toBe("object");
    expect(error.error).toBe("invalid_request");

    // Should not change the number of applications registered
    expect(appCount).toBe(prevAppCount);
  });

  it("prevents creating an application with invalid parameters", async () => {
    expect.assertions(6);

    const prevAppCount = await countApplications();
    const body = new FormData();
    body.append("invalid_property", "invalid");

    const response = await app.request("/api/v1/apps", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const error = await response.json();
    const appCount = await countApplications();

    expect(typeof error).toBe("object");
    expect(error.error).toBe("invalid_request");

    // Should not change the number of applications registered
    expect(appCount).toBe(prevAppCount);
  });
});

/**
 * Theoretically, you should be able to verify application credentials for the
 * Client Authentication (client_id, client_secret) without needing an access
 * token, but currently the Mastodon API requires an access token.
 */
describe("GET /api/v1/apps/verify_credentials", { concurrent: false }, () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let application: Schema.Application;
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:accounts"],
      confidential: true,
    });
    application = await getApplication(client);
  });

  async function actsLikeAnApplicationResponse(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const applicationEntity = await response.json();

    expect(typeof applicationEntity).toBe("object");
    expect(Object.keys(applicationEntity)).toEqual([
      "id",
      "name",
      "website",
      "scopes",
      "redirect_uris",
      "redirect_uri",
    ]);

    expect(applicationEntity.id).toBe(application.id);
    expect(applicationEntity.name).toBe(application.name);
    expect(applicationEntity.website).toBe(application.website);
    expect(Array.isArray(applicationEntity.scopes)).toBeTruthy();
    expect(Array.isArray(applicationEntity.redirect_uris)).toBeTruthy();
    expect(applicationEntity.scopes).toEqual(application.scopes);
    expect(applicationEntity.redirect_uris).toEqual(application.redirectUris);
    expect(typeof applicationEntity.redirect_uri).toBe("string");
  }

  it("successfully returns an application using client credentials", async () => {
    expect.assertions(13);
    const clientCredential = await getClientCredentialToken(client);
    const response = await app.request("/api/v1/apps/verify_credentials", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(clientCredential),
      },
    });

    await actsLikeAnApplicationResponse(response);
  });

  it("successfully returns an application using an access token", async () => {
    expect.assertions(13);
    const accessToken = await getAccessToken(client, account);
    const response = await app.request("/api/v1/apps/verify_credentials", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    await actsLikeAnApplicationResponse(response);
  });
});
