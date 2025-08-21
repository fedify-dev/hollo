import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
  getClientCredentialToken,
} from "../../../tests/helpers/oauth";
import userInfoEndpoint from "./userinfo";

describe.sequential("/oauth/userinfo", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;
  let invalidToken: Awaited<ReturnType<typeof getAccessToken>>;
  let clientCredentialToken: Awaited<
    ReturnType<typeof getClientCredentialToken>
  >;

  const app = new Hono();
  app.route("/oauth/userinfo", userInfoEndpoint);

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount();
    client = await createOAuthApplication({
      scopes: ["profile", "read"],
    });

    accessToken = await getAccessToken(client, account, ["profile"]);
    // wrong scope:
    invalidToken = await getAccessToken(client, account, ["read"]);
    // client credential:
    clientCredentialToken = await getClientCredentialToken(client, ["profile"]);
  });

  it("can retrieve information about the authenticated user using GET", async () => {
    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request("https://hollo.test/oauth/userinfo", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(Object.keys(json)).toEqual([
      "iss",
      "sub",
      "name",
      "preferredUsername",
      "profile",
      "picture",
    ]);

    expect(json.iss).toBe("https://hollo.test/");
    expect(json.sub).toBe("https://hollo.test/@hollo");
    expect(json.name).toBe("Test: hollo");
    expect(json.preferredUsername).toBe("hollo");
    expect(json.profile).toBe("https://hollo.test/@hollo");
    expect(json.picture).toBe(
      "https://hollo.test/image/avatars/original/missing.png",
    );
  });

  it("can retrieve information about the authenticated user using POST", async () => {
    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request("https://hollo.test/oauth/userinfo", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(Object.keys(json)).toEqual([
      "iss",
      "sub",
      "name",
      "preferredUsername",
      "profile",
      "picture",
    ]);

    expect(json.iss).toBe("https://hollo.test/");
    expect(json.sub).toBe("https://hollo.test/@hollo");
    expect(json.name).toBe("Test: hollo");
    expect(json.preferredUsername).toBe("hollo");
    expect(json.profile).toBe("https://hollo.test/@hollo");
    expect(json.picture).toBe(
      "https://hollo.test/image/avatars/original/missing.png",
    );
  });

  it("returns an error if the access token doesn't have profile scope", async () => {
    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request("https://hollo.test/oauth/userinfo", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(invalidToken),
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(Object.keys(json)).toEqual(["error"]);

    expect(json.error).toBe("insufficient_scope");
  });

  it("returns an error if requested without authentication", async () => {
    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request("https://hollo.test/oauth/userinfo", {
      method: "GET",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(Object.keys(json)).toEqual(["error"]);

    expect(json.error).toBe("unauthorized");
  });

  it("returns an error if the access token is a client credential", async () => {
    // We use the full URL in this test as the route calculates values based
    // on the Host header
    const response = await app.request("https://hollo.test/oauth/userinfo", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(clientCredentialToken),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(Object.keys(json)).toEqual(["error"]);

    expect(json.error).toBe("This method requires an authenticated user");
  });
});
