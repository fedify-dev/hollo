import { afterEach, describe, it } from "node:test";
import type { TestContext } from "node:test";

import { cleanDatabase } from "../../../tests/helpers";

import { getLastApplication } from "../../../tests/helpers/oauth";
import app from "../../index";
import { OOB_REDIRECT_URI } from "../../oauth/constants";

describe("POST /api/v1/apps", () => {
  afterEach(async () => {
    await cleanDatabase();
  });

  it(
    "prevents creating an application without a request body",
    { plan: 10 },
    async (t: TestContext) => {
      const response = await app.request("/api/v1/apps", {
        method: "POST",
      });

      console.log(response, await response.json());
    },
  );

  it(
    "successfully creates a confidential client (by default)",
    { plan: 10 },
    async (t: TestContext) => {
      const body = new FormData();
      body.append("scopes", "read:accounts");
      body.append("redirect_uris", OOB_REDIRECT_URI);

      const response = await app.request("/api/v1/apps", {
        method: "POST",
        body,
      });

      t.assert.equal(response.status, 200);
      t.assert.equal(response.headers.get("content-type"), "application/json");
      t.assert.equal(response.headers.get("access-control-allow-origin"), "*");

      const credentialApplication = await response.json();
      const application = await getLastApplication();

      t.assert.equal(typeof credentialApplication, "object");
      t.assert.equal(credentialApplication.id, application.id);
      t.assert.deepEqual(
        credentialApplication.redirect_uris,
        application.redirectUris,
      );
      t.assert.equal(
        credentialApplication.redirect_uri,
        application.redirectUris.join(" "),
      );

      t.assert.deepEqual(application.redirectUris, [OOB_REDIRECT_URI]);
      t.assert.deepEqual(application.scopes, ["read:accounts"]);
      t.assert.equal(application.confidential, true);
    },
  );

  it(
    "successfully creates an application with read scope by default",
    { plan: 10 },
    async (t: TestContext) => {
      const body = new FormData();
      body.append("redirect_uris", OOB_REDIRECT_URI);

      const response = await app.request("/api/v1/apps", {
        method: "POST",
        body,
      });

      t.assert.equal(response.status, 200);
      t.assert.equal(response.headers.get("content-type"), "application/json");
      t.assert.equal(response.headers.get("access-control-allow-origin"), "*");

      const credentialApplication = await response.json();
      const application = await getLastApplication();

      t.assert.equal(typeof credentialApplication, "object");
      t.assert.equal(credentialApplication.id, application.id);
      t.assert.deepEqual(
        credentialApplication.redirect_uris,
        application.redirectUris,
      );
      t.assert.equal(
        credentialApplication.redirect_uri,
        application.redirectUris.join(" "),
      );

      t.assert.deepEqual(application.redirectUris, [OOB_REDIRECT_URI]);
      t.assert.deepEqual(application.scopes, ["read"]);
      t.assert.equal(application.confidential, true);
    },
  );

  // TODO: Support public clients
  it.skip("successfully creates a public client application");

  // TODO: Validation
  // lines: 65-71
  it.skip("successfully creates an application using JSON body");
  // lines: 67-70
  it.skip(
    "prevents creating an application using JSON body with invalid parameters",
  );

  // lines: 76-78
  it.skip(
    "prevents creating an application using POST body with invalid parameters",
  );

  // lines: 27-31
  it.skip("prevents creating an application with invalid redirect_uris");
  // lines: 43-49
  it.skip("prevents creating an application with invalid scopes");
});

describe("GET /api/v1/apps/verify_credentials", () => {
  afterEach(async () => {
    await cleanDatabase();
  });

  // Lines 123-133
  it.skip("successfully returns an application without credentials");
});
