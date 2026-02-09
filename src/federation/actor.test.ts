import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import app from "../index";
import { type PostVisibility, posts } from "../schema";
import type { Uuid } from "../uuid";

const ACTIVITY_JSON = "application/activity+json";

async function createPost(
  accountId: string,
  visibility: PostVisibility,
  content: string,
) {
  const id = crypto.randomUUID() as Uuid;
  await db.insert(posts).values({
    id,
    iri: `https://hollo.test/@hollo/${id}`,
    type: "Note",
    accountId: accountId as Uuid,
    visibility,
    contentHtml: `<p>${content}</p>`,
    content,
    url: `https://hollo.test/@hollo/${id}`,
    published: new Date(),
  });
  return id;
}

describe("Outbox", () => {
  let accountId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const account = await createAccount({ generateKeyPair: true });
    accountId = account.id;
  });

  describe("visibility filtering", () => {
    it("includes public posts in the outbox", async () => {
      expect.assertions(2);

      await createPost(accountId, "public", "public post");

      const response = await app.request("/@hollo/outbox?cursor=0", {
        headers: { Accept: ACTIVITY_JSON },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orderedItems.length).toBe(1);
    });

    it("includes unlisted posts in the outbox", async () => {
      expect.assertions(2);

      await createPost(accountId, "unlisted", "unlisted post");

      const response = await app.request("/@hollo/outbox?cursor=0", {
        headers: { Accept: ACTIVITY_JSON },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orderedItems.length).toBe(1);
    });

    it("excludes private (followers-only) posts from the outbox", async () => {
      expect.assertions(2);

      await createPost(accountId, "private", "followers-only post");

      const response = await app.request("/@hollo/outbox?cursor=0", {
        headers: { Accept: ACTIVITY_JSON },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orderedItems ?? []).toHaveLength(0);
    });

    it("excludes direct (DM) posts from the outbox", async () => {
      expect.assertions(2);

      await createPost(accountId, "direct", "secret DM");

      const response = await app.request("/@hollo/outbox?cursor=0", {
        headers: { Accept: ACTIVITY_JSON },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orderedItems ?? []).toHaveLength(0);
    });

    it("only returns public and unlisted posts when all visibilities are present", async () => {
      expect.assertions(2);

      await createPost(accountId, "public", "public post");
      await createPost(accountId, "unlisted", "unlisted post");
      await createPost(accountId, "private", "followers-only post");
      await createPost(accountId, "direct", "secret DM");

      const response = await app.request("/@hollo/outbox?cursor=0", {
        headers: { Accept: ACTIVITY_JSON },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.orderedItems.length).toBe(2);
    });
  });

  describe("counter", () => {
    it("only counts public and unlisted posts", async () => {
      expect.assertions(2);

      await createPost(accountId, "public", "public post");
      await createPost(accountId, "unlisted", "unlisted post");
      await createPost(accountId, "private", "followers-only post");
      await createPost(accountId, "direct", "secret DM");

      const response = await app.request("/@hollo/outbox", {
        headers: { Accept: ACTIVITY_JSON },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.totalItems).toBe(2);
    });
  });
});
