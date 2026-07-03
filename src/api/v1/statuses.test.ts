import { eq } from "drizzle-orm";
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
import { follows, media, posts } from "../../schema";
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

  it("Can update media descriptions when updating a status", async () => {
    expect.assertions(5);

    const postId = uuidv7();
    const mediumId = uuidv7();
    await db.insert(posts).values({
      id: postId,
      iri: `https://hollo.test/@hollo/${postId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Hello world",
      contentHtml: "<p>Hello world</p>",
      published: new Date(),
    });
    await db.insert(media).values({
      id: mediumId,
      postId,
      type: "image/png",
      url: "https://hollo.test/media/original.png",
      width: 100,
      height: 100,
      description: "Old alt text",
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/thumbnail.png",
      thumbnailWidth: 100,
      thumbnailHeight: 100,
    });

    const response = await app.request(`/api/v1/statuses/${postId}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "Edited status",
        media_attributes: [{ id: mediumId, description: "New alt text" }],
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.content).toBe("<p>Edited status</p>\n");
    expect(json.media_attachments[0].description).toBe("New alt text");

    const medium = await db.query.media.findFirst({
      where: eq(media.id, mediumId),
    });
    expect(medium).not.toBeNull();
    expect(medium?.description).toBe("New alt text");
  });

  it("Can update media descriptions from form data when updating a status", async () => {
    expect.assertions(4);

    const postId = uuidv7();
    const mediumId = uuidv7();
    await db.insert(posts).values({
      id: postId,
      iri: `https://hollo.test/@hollo/${postId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Hello world",
      contentHtml: "<p>Hello world</p>",
      published: new Date(),
    });
    await db.insert(media).values({
      id: mediumId,
      postId,
      type: "image/png",
      url: "https://hollo.test/media/original.png",
      width: 100,
      height: 100,
      description: "Old alt text",
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/thumbnail.png",
      thumbnailWidth: 100,
      thumbnailHeight: 100,
    });

    const body = new FormData();
    body.append("status", "Edited status");
    body.append("media_attributes[0][id]", mediumId);
    body.append("media_attributes[0][description]", "New alt text");

    const response = await app.request(`/api/v1/statuses/${postId}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
      body,
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.media_attachments[0].description).toBe("New alt text");

    const medium = await db.query.media.findFirst({
      where: eq(media.id, mediumId),
    });
    expect(medium).not.toBeNull();
    expect(medium?.description).toBe("New alt text");
  });

  it("Can update media descriptions from sparse form data indexes", async () => {
    expect.assertions(4);

    const postId = uuidv7();
    const mediumId = uuidv7();
    await db.insert(posts).values({
      id: postId,
      iri: `https://hollo.test/@hollo/${postId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Hello world",
      contentHtml: "<p>Hello world</p>",
      published: new Date(),
    });
    await db.insert(media).values({
      id: mediumId,
      postId,
      type: "image/png",
      url: "https://hollo.test/media/original.png",
      width: 100,
      height: 100,
      description: "Old alt text",
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/thumbnail.png",
      thumbnailWidth: 100,
      thumbnailHeight: 100,
    });

    const body = new FormData();
    body.append("status", "Edited status");
    body.append("media_attributes[1000000000][id]", mediumId);
    body.append("media_attributes[1000000000][description]", "New alt text");

    const response = await app.request(`/api/v1/statuses/${postId}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
      body,
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.media_attachments[0].description).toBe("New alt text");

    const medium = await db.query.media.findFirst({
      where: eq(media.id, mediumId),
    });
    expect(medium).not.toBeNull();
    expect(medium?.description).toBe("New alt text");
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

describe.sequential("/api/v1/statuses/:id/reblog", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount({ generateKeyPair: true });
    client = await createOAuthApplication({ scopes: ["write:statuses"] });
    accessToken = await getAccessToken(client, account, ["write:statuses"]);
  });

  it("does not carry quote_id on the boost wrapper when boosting a quote post", async () => {
    expect.assertions(5);

    // Create the quoted post
    const quotedPostId = uuidv7();
    await db.insert(posts).values({
      id: quotedPostId,
      iri: `https://hollo.test/@hollo/${quotedPostId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Original post",
      contentHtml: "<p>Original post</p>",
      published: new Date(),
    });

    // Create a quote post referencing the quoted post
    const quotePostId = uuidv7();
    await db.insert(posts).values({
      id: quotePostId,
      iri: `https://hollo.test/@hollo/${quotePostId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Quote post",
      contentHtml: "<p>Quote post</p>",
      quoteTargetId: quotedPostId,
      published: new Date(),
    });

    // Boost the quote post
    const response = await app.request(
      `/api/v1/statuses/${quotePostId}/reblog`,
      {
        method: "POST",
        headers: { authorization: bearerAuthorization(accessToken) },
      },
    );

    expect(response.status).toBe(200);
    const json = await response.json();

    // The outer boost wrapper must not carry quote_id
    expect(json.quote_id).toBeNull();
    // The inner reblog object must retain the quote_id
    expect(json.reblog).not.toBeNull();
    expect(json.reblog.id).toBe(quotePostId);
    expect(json.reblog.quote_id).toBe(quotedPostId);
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
