import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import * as Schema from "../../schema";
import metadataEndpoint from "./metadata";

describe("GET /.well-known/oauth-authorization-server", () => {
  const app = new Hono();
  app.route("/.well-known/oauth-authorization-server", metadataEndpoint);

  it("returns OAuth authorization server metadata", async () => {
    expect.assertions(15);

    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request(
      "https://hollo.test/.well-known/oauth-authorization-server",
      {
        method: "GET",
      },
    );

    expect(response.status).toBe(200);

    const json = await response.json();

    expect(json.issuer).toBe("https://hollo.test/");
    expect(json.authorization_endpoint).toBe(
      "https://hollo.test/oauth/authorize",
    );
    expect(json.token_endpoint).toBe("https://hollo.test/oauth/token");
    expect(json.revocation_endpoint).toBe("https://hollo.test/oauth/revoke");
    expect(json.userinfo_endpoint).toBe("https://hollo.test/oauth/userinfo");
    // Non-standard, mastodon extension:
    expect(json.app_registration_endpoint).toBe(
      "https://hollo.test/api/v1/apps",
    );

    expect(json.response_types_supported).toEqual(["code"]);
    expect(json.response_modes_supported).toEqual(["query"]);
    expect(json.grant_types_supported).toEqual([
      "authorization_code",
      "client_credentials",
    ]);
    expect(json.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_post",
      "client_secret_basic",
    ]);

    expect(Array.isArray(json.scopes_supported)).toBeTruthy();
    expect(json.scopes_supported).toEqual(Schema.scopeEnum.enumValues);

    expect(Array.isArray(json.code_challenge_methods_supported)).toBeTruthy();
    expect(json.code_challenge_methods_supported).toEqual(["S256"]);
  });
});
