import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
  getApplication,
} from "../../../tests/helpers/oauth";
import db from "../../db";
import app from "../../index";
import { follows, posts } from "../../schema";
import { uuidv7 } from "../../uuid";

describe.sequential("/api/v1/accounts/verify_credentials", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  let application: Awaited<ReturnType<typeof getApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount({ generateKeyPair: true });
    client = await createOAuthApplication({
      scopes: ["write"],
    });
    application = await getApplication(client);
    accessToken = await getAccessToken(client, account, ["write"]);
  });

  it("Successfully creates a new status with a valid access token using JSON", async () => {
    expect.assertions(7);

    const body = JSON.stringify({
      status: "Hello world",
      media_ids: [],
    });

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();

    expect(typeof json).toBe("object");
    expect(json.content).toBe("<p>Hello world</p>\n");
    expect(json.account.id).toBe(account.id);
    expect(json.application.name).toBe(application.name);
  });

  it("Successfully creates a new status with a valid access token using FormData", async () => {
    expect.assertions(7);

    const body = new FormData();
    body.append("status", "Hello world");

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
      body: body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();

    expect(typeof json).toBe("object");
    expect(json.content).toBe("<p>Hello world</p>\n");
    expect(json.account.id).toBe(account.id);
    expect(json.application.name).toBe(application.name);
  });

  it("Can update a status using JSON", async () => {
    const body = JSON.stringify({
      status: "Hello world",
    });

    const createResponse = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: body,
    });

    expect(createResponse.status).toBe(200);
    expect(createResponse.headers.get("content-type")).toBe("application/json");

    const createJson = await createResponse.json();
    const id = createJson.id;

    expect(id).not.toBeNull();

    const updateBody = JSON.stringify({
      status: "Test Update",
    });
    const updateResponse = await app.request(`/api/v1/statuses/${id}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: updateBody,
    });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.headers.get("content-type")).toBe("application/json");
    expect(updateResponse.headers.get("access-control-allow-origin")).toBe("*");

    const updateJson = await updateResponse.json();

    expect(typeof updateJson).toBe("object");
    expect(updateJson.content).toBe("<p>Test Update</p>\n");
  });

  it("Can update a status using FormData", async () => {
    const body = JSON.stringify({
      status: "Hello world",
      media_ids: [],
    });

    const createResponse = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: body,
    });

    expect(createResponse.status).toBe(200);
    expect(createResponse.headers.get("content-type")).toBe("application/json");

    const createJson = await createResponse.json();
    const id = createJson.id;

    expect(id).not.toBeNull();

    const updateBody = new FormData();
    updateBody.append("status", "Test Update");
    const updateResponse = await app.request(`/api/v1/statuses/${id}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
      body: updateBody,
    });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.headers.get("content-type")).toBe("application/json");
    expect(updateResponse.headers.get("access-control-allow-origin")).toBe("*");

    const updateJson = await updateResponse.json();

    expect(typeof updateJson).toBe("object");
    expect(updateJson.content).toBe("<p>Test Update</p>\n");
  });

  it("Issue 177: successfully creates a status with null values, setting appropriate defaults", async () => {
    const body = JSON.stringify({
      language: null,
      status: "Awoo!",
      in_reply_to_id: null,
      sensitive: false,
      spoiler_text: null,
      media_ids: null,
      visibility: null,
      poll: null,
    });

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: body,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    expect(typeof json).toBe("object");

    // Basic creation success
    expect(json.content).toBe("<p>Awoo!</p>\n");
    expect(json.account.id).toBe(account.id);

    // Verify null values are replaced with appropriate defaults
    expect(json.visibility).not.toBeNull();
    expect(json.visibility).toBe("public");
    expect(json.spoiler_text).toBe("");
    expect(json.media_attachments).toEqual([]);
    expect(json.sensitive).toBe(false);
    expect(json.language).not.toBeNull();
    expect(json.poll).toBeNull(); // This one stays null as expected
  });
});

describe.sequential("/api/v1/statuses quotes", () => {
  let author: Awaited<ReturnType<typeof createAccount>>;
  let quoter: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let authorToken: Awaited<ReturnType<typeof getAccessToken>>;
  let quoterToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    author = await createAccount({
      generateKeyPair: true,
      username: "quote-author",
    });
    quoter = await createAccount({
      generateKeyPair: true,
      username: "quote-quoter",
    });
    client = await createOAuthApplication({
      scopes: ["read:statuses", "write:statuses"],
    });
    authorToken = await getAccessToken(client, author, [
      "read:statuses",
      "write:statuses",
    ]);
    quoterToken = await getAccessToken(client, quoter, [
      "read:statuses",
      "write:statuses",
    ]);
  });

  async function createStatus(
    token: typeof authorToken,
    body: Record<string, unknown>,
  ) {
    return await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("denies quotes from other users when quote policy is nobody", async () => {
    expect.assertions(5);

    const quotedResponse = await createStatus(authorToken, {
      status: "Please do not quote",
      quote_approval_policy: "nobody",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();
    expect(quoted.quote_approval.automatic).toEqual([]);

    const deniedResponse = await createStatus(quoterToken, {
      status: "I should not be able to quote this",
      quoted_status_id: quoted.id,
    });
    expect(deniedResponse.status).toBe(422);

    const selfQuoteResponse = await createStatus(authorToken, {
      status: "Self quotes are allowed",
      quoted_status_id: quoted.id,
    });
    expect(selfQuoteResponse.status).toBe(200);
    const selfQuote = await selfQuoteResponse.json();
    expect(selfQuote.quote.state).toBe("accepted");
  });

  it("edits quote policy through the interaction policy endpoint", async () => {
    expect.assertions(5);

    const createResponse = await createStatus(authorToken, {
      status: "Followers can quote this later",
      quote_approval_policy: "public",
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created.quote_approval.automatic).toEqual(["public"]);

    const updateResponse = await app.request(
      `/api/v1/statuses/${created.id}/interaction_policy`,
      {
        method: "PUT",
        headers: {
          authorization: bearerAuthorization(authorToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ quote_approval_policy: "followers" }),
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.quote_approval.automatic).toEqual(["followers"]);
    expect(updated.quote_approval.manual).toEqual([]);
  });

  it("returns revoked quote state when a quote is revoked", async () => {
    expect.assertions(7);

    const quotedResponse = await createStatus(authorToken, {
      status: "Quoted post",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();

    const quoteResponse = await createStatus(quoterToken, {
      status: "Quoting this",
      quoted_status_id: quoted.id,
    });
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json();
    expect(quote.quote.state).toBe("accepted");

    const revokeResponse = await app.request(
      `/api/v1/statuses/${quoted.id}/quotes/${quote.id}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: bearerAuthorization(authorToken),
        },
      },
    );
    expect(revokeResponse.status).toBe(200);
    const revoked = await revokeResponse.json();
    expect(revoked.quote.state).toBe("revoked");
    expect(revoked.quote.quoted_status).toBeNull();

    const quotedAgainResponse = await app.request(
      `/api/v1/statuses/${quoted.id}`,
      {
        headers: {
          authorization: bearerAuthorization(authorToken),
        },
      },
    );
    const quotedAgain = await quotedAgainResponse.json();
    expect(quotedAgain.quotes_count).toBe(0);
  });
});

describe.sequential("/api/v1/statuses visibility", () => {
  let viewer: Awaited<ReturnType<typeof createAccount>>;
  let approvedAuthor: Awaited<ReturnType<typeof createAccount>>;
  let pendingAuthor: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    viewer = await createAccount({ username: "viewer" });
    approvedAuthor = await createAccount({ username: "approved-author" });
    pendingAuthor = await createAccount({ username: "pending-author" });
    client = await createOAuthApplication({
      scopes: ["read:statuses"],
    });
    accessToken = await getAccessToken(client, viewer, ["read:statuses"]);

    await db.insert(follows).values([
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: approvedAuthor.id,
        followerId: viewer.id,
        approved: new Date(),
      },
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: pendingAuthor.id,
        followerId: viewer.id,
        approved: null,
      },
    ]);
  });

  it("allows private statuses from approved follows only", async () => {
    expect.assertions(4);

    const approvedPostId = uuidv7();
    const pendingPostId = uuidv7();

    await db.insert(posts).values([
      {
        id: approvedPostId,
        iri: `https://hollo.test/@approved-author/${approvedPostId}`,
        type: "Note",
        accountId: approvedAuthor.id,
        visibility: "private",
        content: "Approved followers-only post",
        contentHtml: "<p>Approved followers-only post</p>",
        published: new Date(),
      },
      {
        id: pendingPostId,
        iri: `https://hollo.test/@pending-author/${pendingPostId}`,
        type: "Note",
        accountId: pendingAuthor.id,
        visibility: "private",
        content: "Pending followers-only post",
        contentHtml: "<p>Pending followers-only post</p>",
        published: new Date(),
      },
    ]);

    const approvedResponse = await app.request(
      `/api/v1/statuses/${approvedPostId}`,
      {
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      },
    );
    const pendingResponse = await app.request(
      `/api/v1/statuses/${pendingPostId}`,
      {
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      },
    );

    expect(approvedResponse.status).toBe(200);
    expect(pendingResponse.status).toBe(404);

    const json = await approvedResponse.json();

    expect(json.id).toBe(approvedPostId);
    expect(json.visibility).toBe("private");
  });

  it("includes private ancestors from approved follows in status context", async () => {
    expect.assertions(4);

    const ancestorPostId = uuidv7();
    const childPostId = uuidv7();

    await db.insert(posts).values([
      {
        id: ancestorPostId,
        iri: `https://hollo.test/@approved-author/${ancestorPostId}`,
        type: "Note",
        accountId: approvedAuthor.id,
        visibility: "private",
        content: "Private ancestor",
        contentHtml: "<p>Private ancestor</p>",
        published: new Date(),
      },
      {
        id: childPostId,
        iri: `https://hollo.test/@approved-author/${childPostId}`,
        type: "Note",
        accountId: approvedAuthor.id,
        replyTargetId: ancestorPostId,
        visibility: "public",
        content: "Public reply",
        contentHtml: "<p>Public reply</p>",
        published: new Date(),
      },
    ]);

    const response = await app.request(
      `/api/v1/statuses/${childPostId}/context`,
      {
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      },
    );

    expect(response.status).toBe(200);

    const json = await response.json();

    expect(json.ancestors).toHaveLength(1);
    expect(json.ancestors[0].id).toBe(ancestorPostId);
    expect(json.descendants).toHaveLength(0);
  });
});
