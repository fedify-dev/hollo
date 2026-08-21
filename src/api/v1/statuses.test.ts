import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  accountOwners,
  accounts,
  follows,
  instances,
  media,
  mentions,
  posts,
} from "../../schema";
import { uuidv7 } from "../../uuid";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("formats a status using the account's default matching language", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");
    await db
      .update(accountOwners)
      .set({ language: "ko-Kore-KR" })
      .where(eq(accountOwners.id, account.id));

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "漢字와 來日" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.language).toBe("ko-Kore-KR");
    expect(json.content).toBe(
      "<p><ruby>漢字<rp>(</rp><rt>한자</rt><rp>)</rp></ruby>와 " +
        "<ruby>來日<rp>(</rp><rt>내일</rt><rp>)</rp></ruby></p>\n",
    );
    const post = await db.query.posts.findFirst({ where: { id: json.id } });
    expect(post?.contentHtml).toBe(json.content);
  });

  it("uses North Korean readings for an explicit ko-KP language", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "來日", language: "ko-KP" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.language).toBe("ko-KP");
    expect(json.content).toBe(
      "<p><ruby>來日<rp>(</rp><rt>래일</rt><rp>)</rp></ruby></p>\n",
    );
  });

  it("Preserves the requested media attachment order", async () => {
    const firstMediumId = uuidv7();
    const secondMediumId = uuidv7();
    await db.insert(media).values([
      {
        id: firstMediumId,
        type: "image/png",
        url: "https://hollo.test/media/first.png",
        width: 100,
        height: 100,
        thumbnailType: "image/png",
        thumbnailUrl: "https://hollo.test/media/first.png",
        thumbnailWidth: 100,
        thumbnailHeight: 100,
      },
      {
        id: secondMediumId,
        type: "image/png",
        url: "https://hollo.test/media/second.png",
        width: 100,
        height: 100,
        thumbnailType: "image/png",
        thumbnailUrl: "https://hollo.test/media/second.png",
        thumbnailWidth: 100,
        thumbnailHeight: 100,
      },
    ]);

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "Hello world",
        media_ids: [secondMediumId, firstMediumId],
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.media_attachments.map(({ id }: { id: string }) => id)).toEqual([
      secondMediumId,
      firstMediumId,
    ]);
  });

  it("Rejects duplicate media attachments when creating a status", async () => {
    const mediumId = uuidv7();
    await db.insert(media).values({
      id: mediumId,
      type: "image/png",
      url: "https://hollo.test/media/duplicate.png",
      width: 100,
      height: 100,
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/duplicate.png",
      thumbnailWidth: 100,
      thumbnailHeight: 100,
    });

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "Hello world",
        media_ids: [mediumId, mediumId],
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Media not found",
    });
  });

  it("Rejects media already attached to another status on create", async () => {
    const existingPostId = uuidv7();
    const mediumId = uuidv7();
    await db.insert(posts).values({
      id: existingPostId,
      iri: `https://hollo.test/@hollo/${existingPostId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Existing status",
      contentHtml: "<p>Existing status</p>",
      published: new Date(),
    });
    await db.insert(media).values({
      id: mediumId,
      postId: existingPostId,
      type: "image/png",
      url: "https://hollo.test/media/attached.png",
      width: 100,
      height: 100,
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/attached.png",
      thumbnailWidth: 100,
      thumbnailHeight: 100,
    });

    const response = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "New status",
        media_ids: [mediumId],
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Media not found",
    });
    await expect(db.query.posts.findMany()).resolves.toHaveLength(1);
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

  it("formats an updated status when its language matches", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");
    const createResponse = await app.request("/api/v1/statuses", {
      method: "POST",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "Unformatted", language: "en" }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();

    const response = await app.request(`/api/v1/statuses/${created.id}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "漢字", language: "ko-KR" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.language).toBe("ko-KR");
    expect(json.content).toBe(
      "<p><ruby>漢字<rp>(</rp><rt>한자</rt><rp>)</rp></ruby></p>\n",
    );
    const post = await db.query.posts.findFirst({ where: { id: created.id } });
    expect(post?.contentHtml).toBe(json.content);
  });

  it("Returns 404 when a status disappears during an update", async () => {
    const postId = uuidv7();
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

    const originalFindFirst = db.query.posts.findFirst.bind(db.query.posts);
    const findFirstSpy = vi.spyOn(db.query.posts, "findFirst");
    // Drizzle's query builder is awaitable, but the mock returns an equivalent
    // Promise so the deletion can be injected after the preflight read.
    // @ts-expect-error The runtime return value remains await-compatible.
    findFirstSpy.mockImplementation(async (...args) => {
      const post = await originalFindFirst(...args);
      if (post?.id === postId)
        await db.delete(posts).where(eq(posts.id, postId));
      return post;
    });

    let response: Response;
    try {
      response = await app.request(`/api/v1/statuses/${postId}`, {
        method: "PUT",
        headers: {
          authorization: bearerAuthorization(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "Edited status" }),
      });
    } finally {
      findFirstSpy.mockRestore();
    }

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Record not found",
    });
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
      where: { id: { eq: mediumId } },
    });
    expect(medium).not.toBeNull();
    expect(medium?.description).toBe("New alt text");
  });

  it("Can reorder media attachments when updating a status", async () => {
    const postId = uuidv7();
    const firstMediumId = uuidv7();
    const secondMediumId = uuidv7();
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
    await db.insert(media).values([
      {
        id: firstMediumId,
        postId,
        type: "image/png",
        url: "https://hollo.test/media/first.png",
        width: 100,
        height: 100,
        thumbnailType: "image/png",
        thumbnailUrl: "https://hollo.test/media/first.png",
        thumbnailWidth: 100,
        thumbnailHeight: 100,
      },
      {
        id: secondMediumId,
        postId,
        type: "image/png",
        url: "https://hollo.test/media/second.png",
        width: 100,
        height: 100,
        thumbnailType: "image/png",
        thumbnailUrl: "https://hollo.test/media/second.png",
        thumbnailWidth: 100,
        thumbnailHeight: 100,
      },
    ]);

    const response = await app.request(`/api/v1/statuses/${postId}`, {
      method: "PUT",
      headers: {
        authorization: bearerAuthorization(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "Edited status",
        media_ids: [secondMediumId, firstMediumId],
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.media_attachments.map(({ id }: { id: string }) => id)).toEqual([
      secondMediumId,
      firstMediumId,
    ]);
  });

  it("Can attach new media and update its description in one request", async () => {
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
      type: "image/png",
      url: "https://hollo.test/media/new.png",
      width: 100,
      height: 100,
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/new.png",
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
        media_ids: [mediumId],
        media_attributes: [{ id: mediumId, description: "New alt text" }],
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.media_attachments).toMatchObject([
      { id: mediumId, description: "New alt text" },
    ]);
    const medium = await db.query.media.findFirst({
      where: { id: { eq: mediumId } },
    });
    expect(medium).toMatchObject({ postId, description: "New alt text" });
  });

  it("Rejects a media attachment lost to a concurrent status edit", async () => {
    const firstPostId = uuidv7();
    const secondPostId = uuidv7();
    const mediumId = uuidv7();
    await db.insert(posts).values([
      {
        id: firstPostId,
        iri: `https://hollo.test/@hollo/${firstPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "First post",
        contentHtml: "<p>First post</p>",
        published: new Date(),
      },
      {
        id: secondPostId,
        iri: `https://hollo.test/@hollo/${secondPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Second post",
        contentHtml: "<p>Second post</p>",
        published: new Date(),
      },
    ]);
    await db.insert(media).values({
      id: mediumId,
      type: "image/png",
      url: "https://hollo.test/media/concurrent.png",
      width: 100,
      height: 100,
      thumbnailType: "image/png",
      thumbnailUrl: "https://hollo.test/media/concurrent.png",
      thumbnailWidth: 100,
      thumbnailHeight: 100,
    });

    const originalFindFirst = db.query.media.findFirst.bind(db.query.media);
    let validatedRequests = 0;
    let releaseValidations!: () => void;
    const bothValidated = new Promise<void>((resolve) => {
      releaseValidations = resolve;
    });
    const findFirstSpy = vi.spyOn(db.query.media, "findFirst");
    // Drizzle's query builder is awaitable, but the mock returns an equivalent
    // Promise so both preflight reads can be synchronized deterministically.
    // @ts-expect-error The runtime return value remains await-compatible.
    findFirstSpy.mockImplementation(async (...args) => {
      const medium = await originalFindFirst(...args);
      validatedRequests++;
      if (validatedRequests === 2) releaseValidations();
      await bothValidated;
      return medium;
    });

    let responses: Response[];
    try {
      responses = await Promise.all(
        [firstPostId, secondPostId].map((postId) =>
          app.request(`/api/v1/statuses/${postId}`, {
            method: "PUT",
            headers: {
              authorization: bearerAuthorization(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              status: "Edited status",
              media_ids: [mediumId],
            }),
          }),
        ),
      );
    } finally {
      findFirstSpy.mockRestore();
    }

    expect(responses.map((response) => response.status).toSorted()).toEqual([
      200, 422,
    ]);
    const medium = await db.query.media.findFirst({
      where: { id: { eq: mediumId } },
    });
    expect([firstPostId, secondPostId]).toContain(medium?.postId);
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
      where: { id: { eq: mediumId } },
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
      where: { id: { eq: mediumId } },
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

  it("allows same-instance quotes regardless of quote policy and emits an authorization IRI", async () => {
    expect.assertions(7);

    const quotedResponse = await createStatus(authorToken, {
      status: "Please do not quote",
      quote_approval_policy: "nobody",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();
    expect(quoted.quote_approval.automatic).toEqual([]);

    const localQuoteResponse = await createStatus(quoterToken, {
      status: "Same-instance accounts can always quote each other",
      quoted_status_id: quoted.id,
    });
    expect(localQuoteResponse.status).toBe(200);
    const localQuote = await localQuoteResponse.json();
    expect(localQuote.quote.state).toBe("accepted");

    const storedLocalQuote = await db.query.posts.findFirst({
      where: { id: { eq: localQuote.id } },
    });
    expect(storedLocalQuote?.quoteAuthorizationIri).toBe(
      `${quoted.uri}/quote_authorizations/${localQuote.id}`,
    );

    const selfQuoteResponse = await createStatus(authorToken, {
      status: "Self quotes are allowed",
      quoted_status_id: quoted.id,
    });
    expect(selfQuoteResponse.status).toBe(200);
    const selfQuote = await selfQuoteResponse.json();
    expect(selfQuote.quote.state).toBe("accepted");
  });

  it("denies quotes of remote targets when the remote policy is nobody", async () => {
    expect.assertions(1);

    const remoteAuthorId = uuidv7();
    const remotePostId = uuidv7();
    const remotePostIri = `https://remote.test/@remote-author/${remotePostId}`;
    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: remoteAuthorId,
      iri: "https://remote.test/@remote-author",
      type: "Person",
      name: "Remote Author",
      handle: "@remote-author@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@remote-author/inbox",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(posts).values({
      id: remotePostId,
      iri: remotePostIri,
      type: "Note",
      accountId: remoteAuthorId,
      visibility: "public",
      quoteApprovalPolicy: "nobody",
      content: "Please do not quote",
      contentHtml: "<p>Please do not quote</p>\n",
      url: remotePostIri,
      published: new Date(),
    });

    const deniedResponse = await createStatus(quoterToken, {
      status: "I should not be able to quote this remote post",
      quoted_status_id: remotePostId,
    });
    expect(deniedResponse.status).toBe(422);
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

  it("does not fan out direct interaction policy updates to followers", async () => {
    expect.assertions(3);

    const mentionedAccountId = uuidv7();
    const followerAccountId = uuidv7();
    const directPostId = uuidv7();
    const directPostIri = `https://hollo.test/@quote-author/${directPostId}`;

    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values([
      {
        id: mentionedAccountId,
        iri: "https://remote.test/@mentioned",
        type: "Person",
        name: "Mentioned",
        handle: "@mentioned@remote.test",
        bioHtml: "",
        protected: false,
        inboxUrl: "https://remote.test/@mentioned/inbox",
        sharedInboxUrl: "https://remote.test/inbox",
        instanceHost: "remote.test",
      },
      {
        id: followerAccountId,
        iri: "https://remote.test/@follower",
        type: "Person",
        name: "Follower",
        handle: "@follower@remote.test",
        bioHtml: "",
        protected: false,
        inboxUrl: "https://remote.test/@follower/inbox",
        sharedInboxUrl: "https://remote.test/followers-inbox",
        instanceHost: "remote.test",
      },
    ]);
    await db.insert(follows).values({
      iri: `https://remote.test/@follower#follows/${crypto.randomUUID()}`,
      followingId: author.id,
      followerId: followerAccountId,
      approved: new Date(),
    });
    await db.insert(posts).values({
      id: directPostId,
      iri: directPostIri,
      type: "Note",
      accountId: author.id,
      visibility: "direct",
      quoteApprovalPolicy: "public",
      content: "@mentioned@remote.test Private quote policy update",
      contentHtml:
        "<p>@mentioned@remote.test Private quote policy update</p>\n",
      url: directPostIri,
      published: new Date(),
    });
    await db.insert(mentions).values({
      postId: directPostId,
      accountId: mentionedAccountId,
    });

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const response = await app.request(
        `/api/v1/statuses/${directPostId}/interaction_policy`,
        {
          method: "PUT",
          headers: {
            authorization: bearerAuthorization(authorToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ quote_approval_policy: "nobody" }),
        },
      );
      expect(response.status).toBe(200);

      await vi.waitFor(() => {
        if (
          !fetch.mock.calls.some(([input]) => {
            const url = input instanceof Request ? input.url : input.toString();
            return url === "https://remote.test/@mentioned/inbox";
          })
        ) {
          throw new Error("Direct update was not sent to the mentioned actor");
        }
      });
      expect(
        fetch.mock.calls.some(([input]) => {
          const url = input instanceof Request ? input.url : input.toString();
          return url === "https://remote.test/followers-inbox";
        }),
      ).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
    }
  });

  it("reports quote approval as automatic for approved followers", async () => {
    expect.assertions(4);

    const quotedResponse = await createStatus(authorToken, {
      status: "Followers can quote this",
      quote_approval_policy: "followers",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();

    await db.insert(follows).values({
      iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
      followingId: author.id,
      followerId: quoter.id,
      approved: new Date(),
    });

    const response = await app.request(`/api/v1/statuses/${quoted.id}`, {
      headers: {
        authorization: bearerAuthorization(quoterToken),
      },
    });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.quote_approval.automatic).toEqual(["followers"]);
    expect(status.quote_approval.current_user).toBe("automatic");
  });

  it("treats private quote approval as nobody for followers", async () => {
    expect.assertions(4);

    await db.insert(follows).values({
      iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
      followingId: author.id,
      followerId: quoter.id,
      approved: new Date(),
    });

    const quotedResponse = await createStatus(authorToken, {
      status: "Approved followers cannot quote this private status",
      visibility: "private",
      quote_approval_policy: "followers",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();

    const response = await app.request(`/api/v1/statuses/${quoted.id}`, {
      headers: {
        authorization: bearerAuthorization(quoterToken),
      },
    });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.quote_approval.automatic).toEqual([]);
    expect(status.quote_approval.current_user).toBe("denied");
  });

  it("denies followers quoting private statuses", async () => {
    expect.assertions(4);

    await db.insert(follows).values({
      iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
      followingId: author.id,
      followerId: quoter.id,
      approved: new Date(),
    });

    const quotedResponse = await createStatus(authorToken, {
      status: "Followers cannot quote this private status",
      visibility: "private",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();

    const quoteResponse = await createStatus(quoterToken, {
      status: "Quoting this private status",
      quoted_status_id: quoted.id,
      visibility: "public",
    });
    expect(quoteResponse.status).toBe(422);

    const selfQuoteResponse = await createStatus(authorToken, {
      status: "Self quoting this private status",
      quoted_status_id: quoted.id,
      visibility: "private",
    });
    expect(selfQuoteResponse.status).toBe(200);
    const selfQuote = await selfQuoteResponse.json();
    expect(selfQuote.quote.state).toBe("accepted");
  });

  it("allows direct self-quotes without self-mentions", async () => {
    expect.assertions(3);

    const quotedResponse = await createStatus(authorToken, {
      status: "Self-quotable post",
    });
    expect(quotedResponse.status).toBe(200);
    const quoted = await quotedResponse.json();

    const selfQuoteResponse = await createStatus(authorToken, {
      status: "Direct self-quote",
      quoted_status_id: quoted.id,
      visibility: "direct",
    });
    expect(selfQuoteResponse.status).toBe(200);
    const selfQuote = await selfQuoteResponse.json();
    expect(selfQuote.quote.state).toBe("accepted");
  });

  it("accepts quotes of remote posts without FEP-044f policy", async () => {
    expect.assertions(3);

    const remoteAccountId = uuidv7();
    const quotedPostId = uuidv7();
    const quotedPostIri = `https://remote.test/@legacy/${quotedPostId}`;

    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: remoteAccountId,
      iri: "https://remote.test/@legacy",
      type: "Person",
      name: "Legacy remote author",
      handle: "@legacy@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@legacy/inbox",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: remoteAccountId,
      visibility: "public",
      quoteApprovalPolicy: null,
      content: "Legacy remote quoted post",
      contentHtml: "<p>Legacy remote quoted post</p>\n",
      url: quotedPostIri,
      published: new Date(),
    });

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const quoteResponse = await createStatus(quoterToken, {
        status: "Quoting a legacy remote post",
        quoted_status_id: quotedPostId,
      });
      expect(quoteResponse.status).toBe(200);
      const quote = await quoteResponse.json();
      expect(quote.quote.state).toBe("accepted");
      const activities = await Promise.all(
        fetch.mock.calls.map(async ([input]) => {
          const request = input instanceof Request ? input : null;
          return request == null ? null : await request.clone().json();
        }),
      );
      expect(
        activities.some((activity) => activity?.type === "QuoteRequest"),
      ).toBe(false);
    } finally {
      fetch.mockRestore();
    }
  });

  it("requests authorization for cached remote public quote policies", async () => {
    expect.assertions(7);

    const remoteAccountId = uuidv7();
    const quotedPostId = uuidv7();
    const quotedPostIri = `https://remote.test/@fep-author/${quotedPostId}`;

    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: remoteAccountId,
      iri: "https://remote.test/@fep-author",
      type: "Person",
      name: "FEP-044f remote author",
      handle: "@fep-author@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@fep-author/inbox",
      followersUrl: "https://remote.test/@fep-author/followers",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: remoteAccountId,
      visibility: "public",
      quoteApprovalPolicy: "public",
      content: "FEP-044f public remote post",
      contentHtml: "<p>FEP-044f public remote post</p>\n",
      url: quotedPostIri,
      published: new Date(),
    });

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const quoteResponse = await createStatus(quoterToken, {
        status: "Quoting a public FEP-044f remote post",
        quoted_status_id: quotedPostId,
      });
      expect(quoteResponse.status).toBe(200);
      const quote = await quoteResponse.json();
      expect(quote.quote.state).toBe("pending");
      expect(quote.quote.quoted_status).toBeNull();

      let hasQuoteRequest = false;
      await vi.waitFor(async () => {
        const activities = await Promise.all(
          fetch.mock.calls.map(async ([input]) => {
            const request = input instanceof Request ? input : null;
            return request == null ? null : await request.clone().json();
          }),
        );
        hasQuoteRequest = activities.some(
          (activity) => activity?.type === "QuoteRequest",
        );
        if (!hasQuoteRequest) throw new Error("QuoteRequest was not sent yet");
      });
      expect(hasQuoteRequest).toBe(true);

      const objectResponse = await app.request(`/@quote-quoter/${quote.id}`, {
        headers: { Accept: "application/activity+json" },
      });
      const object = await objectResponse.json();
      expect(object.quote).toBeUndefined();
      expect(object.quoteUrl).toBeUndefined();
      expect(object.quoteAuthorization).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  it("requests authorization for cached remote followers-only quotes from approved followers", async () => {
    expect.assertions(3);

    const remoteAccountId = uuidv7();
    const quotedPostId = uuidv7();
    const quotedPostIri = `https://remote.test/@followers-author/${quotedPostId}`;

    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: remoteAccountId,
      iri: "https://remote.test/@followers-author",
      type: "Person",
      name: "Followers-only remote author",
      handle: "@followers-author@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@followers-author/inbox",
      followersUrl: "https://remote.test/@followers-author/followers",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(follows).values({
      iri: `https://remote.test/follows/${crypto.randomUUID()}`,
      followingId: remoteAccountId,
      followerId: quoter.id,
      approved: new Date(),
    });
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: remoteAccountId,
      visibility: "public",
      quoteApprovalPolicy: "followers",
      content: "Followers-only remote post",
      contentHtml: "<p>Followers-only remote post</p>\n",
      url: quotedPostIri,
      published: new Date(),
    });

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const quoteResponse = await createStatus(quoterToken, {
        status: "Quoting a followers-only remote post as an approved follower",
        quoted_status_id: quotedPostId,
      });
      expect(quoteResponse.status).toBe(200);
      const quote = await quoteResponse.json();
      expect(quote.quote.state).toBe("pending");
      let hasQuoteRequest = false;
      await vi.waitFor(async () => {
        const activities = await Promise.all(
          fetch.mock.calls.map(async ([input]) => {
            const request = input instanceof Request ? input : null;
            return request == null ? null : await request.clone().json();
          }),
        );
        hasQuoteRequest = activities.some(
          (activity) => activity?.type === "QuoteRequest",
        );
        if (!hasQuoteRequest) throw new Error("QuoteRequest was not sent yet");
      });
      expect(hasQuoteRequest).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  it("does not silently accept followers-only quotes from non-followers", async () => {
    expect.assertions(1);

    const remoteAccountId = uuidv7();
    const quotedPostId = uuidv7();
    const quotedPostIri = `https://remote.test/@followers-author2/${quotedPostId}`;

    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: remoteAccountId,
      iri: "https://remote.test/@followers-author2",
      type: "Person",
      name: "Followers-only remote author 2",
      handle: "@followers-author2@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@followers-author2/inbox",
      followersUrl: "https://remote.test/@followers-author2/followers",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: remoteAccountId,
      visibility: "public",
      quoteApprovalPolicy: "followers",
      content: "Followers-only remote post",
      contentHtml: "<p>Followers-only remote post</p>\n",
      url: quotedPostIri,
      published: new Date(),
    });

    const quoteResponse = await createStatus(quoterToken, {
      status: "Quoting a followers-only remote post without following",
      quoted_status_id: quotedPostId,
    });
    expect(quoteResponse.status).toBe(422);
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

  it("fans out an Update when revoking a local quote", async () => {
    expect.assertions(4);

    const followerAccountId = uuidv7();
    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: followerAccountId,
      iri: "https://remote.test/@quoter-follower",
      type: "Person",
      name: "Quoter follower",
      handle: "@quoter-follower@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@quoter-follower/inbox",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(follows).values({
      iri: `https://remote.test/@quoter-follower#follows/${crypto.randomUUID()}`,
      followingId: quoter.id,
      followerId: followerAccountId,
      approved: new Date(),
    });

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
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

      const isRemoteInboxCall = (
        call: [string | URL | Request, RequestInit?],
      ) =>
        call[0] instanceof Request &&
        call[0].url === "https://remote.test/inbox";
      const findUpdate = async () => {
        for (const call of fetch.mock.calls) {
          if (!isRemoteInboxCall(call)) continue;
          const request = call[0] as Request;
          const body = await request.clone().json();
          if (body?.type === "Update") return body;
        }
        return null;
      };
      let activity: Record<string, unknown> | null = null;
      await vi.waitFor(async () => {
        activity = await findUpdate();
        if (activity == null) {
          throw new Error("Update was not fanned out");
        }
      });
      if (activity == null) throw new Error("Update activity not captured");
      // The Note no longer carries `quoteAuthorization` since the revocation
      // cleared `quoteAuthorizationIri`.
      const object = (activity as { object: Record<string, unknown> }).object;
      expect(object.quoteAuthorization).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  it("fans out an Update when revoking a legacy local quote without an authorization IRI", async () => {
    expect.assertions(3);

    const followerAccountId = uuidv7();
    const quotedPostId = uuidv7();
    const quotingPostId = uuidv7();
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotingPostIri = `https://hollo.test/@quote-quoter/${quotingPostId}`;
    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: followerAccountId,
      iri: "https://remote.test/@quoter-follower",
      type: "Person",
      name: "Quoter follower",
      handle: "@quoter-follower@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@quoter-follower/inbox",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(follows).values({
      iri: `https://remote.test/@quoter-follower#follows/${crypto.randomUUID()}`,
      followingId: quoter.id,
      followerId: followerAccountId,
      approved: new Date(),
    });
    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id,
        visibility: "public",
        content: "Legacy quoted post",
        contentHtml: "<p>Legacy quoted post</p>\n",
        url: quotedPostIri,
        quotesCount: 1,
        published: new Date(),
      },
      {
        id: quotingPostId,
        iri: quotingPostIri,
        type: "Note",
        accountId: quoter.id,
        quoteTargetId: quotedPostId,
        quoteTargetIri: quotedPostIri,
        quoteState: "accepted",
        quoteAuthorizationIri: null,
        visibility: "public",
        content: "Legacy local quote",
        contentHtml: "<p>Legacy local quote</p>\n",
        url: quotingPostIri,
        published: new Date(),
      },
    ]);

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const revokeResponse = await app.request(
        `/api/v1/statuses/${quotedPostId}/quotes/${quotingPostId}/revoke`,
        {
          method: "POST",
          headers: {
            authorization: bearerAuthorization(authorToken),
          },
        },
      );
      expect(revokeResponse.status).toBe(200);

      const isRemoteInboxCall = (
        call: [string | URL | Request, RequestInit?],
      ) =>
        call[0] instanceof Request &&
        call[0].url === "https://remote.test/inbox";
      const findUpdate = async () => {
        for (const call of fetch.mock.calls) {
          if (!isRemoteInboxCall(call)) continue;
          const request = call[0] as Request;
          const body = await request.clone().json();
          if (body?.type === "Update") return body;
        }
        return null;
      };
      let activity: Record<string, unknown> | null = null;
      await vi.waitFor(async () => {
        activity = await findUpdate();
        if (activity == null) {
          throw new Error("Update was not fanned out for legacy local quote");
        }
      });
      if (activity == null) throw new Error("Update activity not captured");
      const object = (activity as { object: Record<string, unknown> }).object;
      expect(object).toBeDefined();
      expect(object.quoteAuthorization).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  it("sends a QuoteAuthorization deletion when revoking a remote quote", async () => {
    expect.assertions(7);

    const remoteAccountId = uuidv7();
    const quotedPostId = uuidv7();
    const quotingPostId = uuidv7();
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotingPostIri = `https://remote.test/@quoter/${quotingPostId}`;
    const quoteAuthorizationIri = `${quotedPostIri}/quote_authorizations/${quotingPostId}`;

    await db.insert(instances).values({ host: "remote.test" });
    await db.insert(accounts).values({
      id: remoteAccountId,
      iri: "https://remote.test/@quoter",
      type: "Person",
      name: "Remote quoter",
      handle: "@quoter@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: "https://remote.test/@quoter/inbox",
      sharedInboxUrl: "https://remote.test/inbox",
      instanceHost: "remote.test",
    });
    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id,
        visibility: "public",
        content: "Quoted post",
        contentHtml: "<p>Quoted post</p>\n",
        url: quotedPostIri,
        quotesCount: 1,
        published: new Date(),
      },
      {
        id: quotingPostId,
        iri: quotingPostIri,
        type: "Note",
        accountId: remoteAccountId,
        quoteTargetId: quotedPostId,
        quoteTargetIri: quotedPostIri,
        quoteState: "accepted",
        quoteAuthorizationIri,
        visibility: "public",
        content: "Remote quote",
        contentHtml: "<p>Remote quote</p>\n",
        url: quotingPostIri,
        published: new Date(),
      },
    ]);

    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    try {
      const revokeResponse = await app.request(
        `/api/v1/statuses/${quotedPostId}/quotes/${quotingPostId}/revoke`,
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

      const isRemoteInboxCall = ([input]: [
        string | URL | Request,
        RequestInit?,
      ]) => {
        const url = input instanceof Request ? input.url : input.toString();
        return url === "https://remote.test/inbox";
      };
      await vi.waitFor(() => {
        if (!fetch.mock.calls.some(isRemoteInboxCall)) {
          throw new Error("Quote authorization deletion was not sent");
        }
      });
      const matchingCall = fetch.mock.calls.find(isRemoteInboxCall);
      expect(matchingCall).toBeDefined();
      const request = matchingCall?.[0];
      expect(request).toBeInstanceOf(Request);
      const activity =
        request instanceof Request ? await request.clone().json() : null;
      expect(activity.type).toBe("Delete");
      expect(activity.object.type).toBe("QuoteAuthorization");
      expect(activity.object.id).toBe(quoteAuthorizationIri);
    } finally {
      fetch.mockRestore();
    }
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
