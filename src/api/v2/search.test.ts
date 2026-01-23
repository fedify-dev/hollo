import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";

import db from "../../db";
import app from "../../index";
import {
  accounts as accountsTable,
  instances,
  media,
  type NewPost,
  polls,
  posts,
} from "../../schema";
import type { Uuid } from "../../uuid";

// Helper to create test posts for search tests
async function createTestPost(
  accountId: Uuid,
  overrides: Partial<NewPost> = {},
): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db.insert(posts).values({
    id,
    iri: `https://hollo.test/posts/${id}`,
    type: "Note",
    accountId,
    visibility: "public",
    contentHtml: overrides.contentHtml ?? "<p>Test post content</p>",
    content: overrides.content ?? "Test post content",
    published: overrides.published ?? new Date(),
    ...overrides,
  });

  return id;
}

// Helper to create test media
async function createTestMedia(postId: Uuid): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db.insert(media).values({
    id,
    postId,
    type: "image/png",
    url: `https://hollo.test/media/${id}.png`,
    width: 100,
    height: 100,
    thumbnailType: "image/png",
    thumbnailUrl: `https://hollo.test/media/${id}_thumb.png`,
    thumbnailWidth: 50,
    thumbnailHeight: 50,
  });

  return id;
}

// Helper to create test poll
async function createTestPoll(): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db.insert(polls).values({
    id,
    multiple: false,
    votersCount: 0,
    expires: new Date(Date.now() + 86400000),
  });

  return id;
}

// Helper to create another account for testing from: operator
async function createOtherAccount(username: string): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db
    .insert(instances)
    .values({ host: "other.test" })
    .onConflictDoNothing();

  await db.insert(accountsTable).values({
    id,
    iri: `https://other.test/@${username}`,
    instanceHost: "other.test",
    type: "Person",
    name: `Other: ${username}`,
    emojis: {},
    handle: `@${username}@other.test`,
    bioHtml: "",
    url: `https://other.test/@${username}`,
    protected: false,
    inboxUrl: `https://other.test/@${username}/inbox`,
  });

  return id;
}

describe.sequential("/api/v2/search", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount({ generateKeyPair: true });
    client = await createOAuthApplication({
      scopes: ["read:search", "write"],
    });
    accessToken = await getAccessToken(client, account, [
      "read:search",
      "write",
    ]);
  });

  describe("limit parameter", () => {
    it("returns results respecting the limit parameter", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=5", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(5);
      expect(json.statuses.length).toBeLessThanOrEqual(5);
    });

    it("caps limit at 40 when a higher value is provided", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=100", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(40);
      expect(json.statuses.length).toBeLessThanOrEqual(40);
    });

    it("uses default limit of 20 when not specified", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(20);
      expect(json.statuses.length).toBeLessThanOrEqual(20);
    });

    it("handles limit of 1 correctly", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=1", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(1);
      expect(json.statuses.length).toBeLessThanOrEqual(1);
    });

    it("treats limit of 0 as 1 (minimum limit)", async () => {
      expect.assertions(4);

      const response = await app.request("/api/v2/search?q=test&limit=0", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const json = await response.json();
      expect(json.accounts.length).toBeLessThanOrEqual(1);
      expect(json.statuses.length).toBeLessThanOrEqual(1);
    });
  });

  describe("authentication", () => {
    it("returns 401 when no access token is provided", async () => {
      expect.assertions(2);

      const response = await app.request("/api/v2/search?q=test", {
        method: "GET",
      });

      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error).toBe("unauthorized");
    });
  });

  describe("search operators", () => {
    it("filters by has:media operator", async () => {
      expect.assertions(4);

      // Create posts with and without media
      const postWithMediaId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Post with media</p>",
      });
      await createTestMedia(postWithMediaId);

      const postWithoutMediaId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Post without media</p>",
      });

      const response = await app.request(
        "/api/v2/search?q=has:media&type=statuses",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(postWithMediaId);
      expect(statusIds).not.toContain(postWithoutMediaId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by has:poll operator", async () => {
      expect.assertions(4);

      const pollId = await createTestPoll();
      const postWithPollId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Post with poll</p>",
        pollId,
      });

      const postWithoutPollId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Post without poll</p>",
      });

      const response = await app.request(
        "/api/v2/search?q=has:poll&type=statuses",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(postWithPollId);
      expect(statusIds).not.toContain(postWithoutPollId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by is:sensitive operator", async () => {
      expect.assertions(4);

      const sensitivePostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Sensitive post</p>",
        sensitive: true,
      });

      const normalPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Normal post</p>",
        sensitive: false,
      });

      const response = await app.request(
        "/api/v2/search?q=is:sensitive&type=statuses",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(sensitivePostId);
      expect(statusIds).not.toContain(normalPostId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by language: operator", async () => {
      expect.assertions(4);

      const koreanPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Korean post</p>",
        language: "ko",
      });

      const englishPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>English post</p>",
        language: "en",
      });

      const response = await app.request(
        "/api/v2/search?q=language:ko&type=statuses",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(koreanPostId);
      expect(statusIds).not.toContain(englishPostId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by from: operator", async () => {
      expect.assertions(4);

      // Create another account
      const otherId = await createOtherAccount("alice");

      const ownerPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Owner post</p>",
      });

      const alicePostId = await createTestPost(otherId, {
        contentHtml: "<p>Alice post</p>",
      });

      const response = await app.request(
        "/api/v2/search?q=from:alice&type=statuses",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(alicePostId);
      expect(statusIds).not.toContain(ownerPostId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });

    it("supports negation with - prefix", async () => {
      expect.assertions(4);

      const postWithMediaId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>With media</p>",
      });
      await createTestMedia(postWithMediaId);

      const postWithoutMediaId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Without media</p>",
      });

      const response = await app.request(
        "/api/v2/search?q=-has:media&type=statuses",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).not.toContain(postWithMediaId);
      expect(statusIds).toContain(postWithoutMediaId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });

    it("supports OR operator", async () => {
      expect.assertions(5);

      const postWithMediaId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>With media</p>",
      });
      await createTestMedia(postWithMediaId);

      const pollId = await createTestPoll();
      const postWithPollId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>With poll</p>",
        pollId,
      });

      const plainPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Plain post</p>",
      });

      const response = await app.request(
        `/api/v2/search?q=${encodeURIComponent("has:media OR has:poll")}&type=statuses`,
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(postWithMediaId);
      expect(statusIds).toContain(postWithPollId);
      expect(statusIds).not.toContain(plainPostId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(2);
    });

    it("supports combined operators", async () => {
      expect.assertions(4);

      const matchingPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Hello world with media</p>",
        sensitive: false,
      });
      await createTestMedia(matchingPostId);

      const sensitivePostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Hello sensitive</p>",
        sensitive: true,
      });
      await createTestMedia(sensitivePostId);

      const noMediaPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Hello no media</p>",
        sensitive: false,
      });

      const response = await app.request(
        `/api/v2/search?q=${encodeURIComponent("hello has:media -is:sensitive")}&type=statuses`,
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).toContain(matchingPostId);
      expect(statusIds).not.toContain(sensitivePostId);
      expect(statusIds).not.toContain(noMediaPostId);
    });

    it("supports date range with before: and after:", async () => {
      expect.assertions(5);

      const oldPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Old post</p>",
        published: new Date("2024-01-01"),
      });

      const midPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>Mid post</p>",
        published: new Date("2024-06-15"),
      });

      const newPostId = await createTestPost(account.id as Uuid, {
        contentHtml: "<p>New post</p>",
        published: new Date("2024-12-31"),
      });

      const response = await app.request(
        `/api/v2/search?q=${encodeURIComponent("after:2024-06-01 before:2024-07-01")}&type=statuses`,
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();

      const statusIds = json.statuses.map((s: { id: string }) => s.id);
      expect(statusIds).not.toContain(oldPostId);
      expect(statusIds).toContain(midPostId);
      expect(statusIds).not.toContain(newPostId);
      expect(json.statuses.length).toBeGreaterThanOrEqual(1);
    });
  });
});
