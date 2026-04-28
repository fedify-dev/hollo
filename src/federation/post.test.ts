import type { Context, InboxContext } from "@fedify/fedify";
import {
  Announce,
  InteractionPolicy,
  InteractionRule,
  Note,
  Person,
  PUBLIC_COLLECTION,
  type RemoteDocument,
} from "@fedify/vocab";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows, instances, posts, timelinePosts } from "../schema";
import type { Uuid } from "../uuid";
import { onPostShared } from "./inbox";
import { persistPost, persistSharingPost, toObject } from "./post";

async function seedRemoteAccount(username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://remote.test/@${username}`;
  await db
    .insert(instances)
    .values({
      host: "remote.test",
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  await db.insert(accounts).values({
    id,
    iri,
    type: "Person",
    name: username,
    handle: `@${username}@remote.test`,
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${iri}/inbox`,
    followersUrl: `${iri}/followers`,
    sharedInboxUrl: "https://remote.test/inbox",
    featuredUrl: `${iri}/featured`,
    instanceHost: "remote.test",
    published: new Date(),
  });
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, id),
    with: { owner: true },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

function createPerson(account: {
  handle: string;
  iri: string;
  followersUrl: string | null;
}) {
  return new Person({
    id: new URL(account.iri),
    name: account.handle,
    inbox: new URL(`${account.iri}/inbox`),
    followers:
      account.followersUrl == null ? null : new URL(account.followersUrl),
  });
}

function createAnnounce(id: string, actor: Person, object: string | Note) {
  return new Announce({
    id: new URL(id),
    actor,
    object: typeof object === "string" ? new URL(object) : object,
    to: PUBLIC_COLLECTION,
  });
}

function createCtx() {
  const forwardActivity = vi.fn(async () => undefined);
  const ctx = {
    origin: "https://hollo.test",
    parseUri: () => null,
    forwardActivity,
  } as unknown as InboxContext<void>;
  return { ctx, forwardActivity };
}

async function seedShareScenario() {
  const owner = await createAccount({ username: "hollo" });
  const author = await seedRemoteAccount("author");
  const sharer = await seedRemoteAccount("sharer");
  await db.insert(follows).values({
    iri: `https://hollo.test/@hollo#follows/${sharer.id}`,
    followingId: sharer.id,
    followerId: owner.id as Uuid,
    approved: new Date(),
    shares: true,
    notify: false,
  });
  const originalPostId = crypto.randomUUID() as Uuid;
  const originalPostIri = "https://remote.test/@author/posts/1";
  await db.insert(posts).values({
    id: originalPostId,
    iri: originalPostIri,
    type: "Note",
    accountId: author.id,
    visibility: "public",
    contentHtml: "<p>Shared once</p>",
    content: "Shared once",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return {
    actor: createPerson(sharer),
    object: new Note({ id: new URL(originalPostIri) }),
    originalPostId,
    originalPostIri,
    sharer,
  };
}

async function seedLocalPostShareScenario() {
  const author = await createAccount({ username: "hollo" });
  const sharer = await seedRemoteAccount("sharer");
  const originalPostId = crypto.randomUUID() as Uuid;
  const originalPostIri = `https://hollo.test/@hollo/${originalPostId}`;
  await db.insert(posts).values({
    id: originalPostId,
    iri: originalPostIri,
    type: "Note",
    accountId: author.id as Uuid,
    visibility: "public",
    contentHtml: "<p>Local post</p>",
    content: "Local post",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return {
    actor: createPerson(sharer),
    object: new Note({ id: new URL(originalPostIri) }),
    originalPostIri,
  };
}

describe("persistSharingPost", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns an existing share when the same actor announces the same post with another IRI", async () => {
    expect.assertions(5);
    const { actor, object, originalPostId, originalPostIri, sharer } =
      await seedShareScenario();

    const first = await persistSharingPost(
      db,
      createAnnounce(
        "https://remote.test/@sharer/announces/1",
        actor,
        originalPostIri,
      ),
      object,
      "https://hollo.test",
      { account: sharer },
    );
    const second = await persistSharingPost(
      db,
      createAnnounce(
        "https://remote.test/@sharer/announces/2",
        actor,
        originalPostIri,
      ),
      object,
      "https://hollo.test",
      { account: sharer },
    );

    const sharingPosts = await db.query.posts.findMany({
      where: and(
        eq(posts.accountId, sharer.id),
        eq(posts.sharingId, originalPostId),
      ),
    });
    const timelineRows = await db.query.timelinePosts.findMany({
      where: eq(timelinePosts.postId, first!.id),
    });
    const originalPost = await db.query.posts.findFirst({
      where: eq(posts.id, originalPostId),
    });
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(sharingPosts).toHaveLength(1);
    expect(timelineRows).toHaveLength(1);
    expect(originalPost?.sharesCount).toBe(1);
  });

  it("handles concurrent duplicate announces atomically", async () => {
    expect.assertions(5);
    const { actor, object, originalPostId, originalPostIri, sharer } =
      await seedShareScenario();

    const [first, second] = await Promise.all([
      persistSharingPost(
        db,
        createAnnounce(
          "https://remote.test/@sharer/announces/1",
          actor,
          originalPostIri,
        ),
        object,
        "https://hollo.test",
        { account: sharer },
      ),
      persistSharingPost(
        db,
        createAnnounce(
          "https://remote.test/@sharer/announces/2",
          actor,
          originalPostIri,
        ),
        object,
        "https://hollo.test",
        { account: sharer },
      ),
    ]);

    const sharingPosts = await db.query.posts.findMany({
      where: and(
        eq(posts.accountId, sharer.id),
        eq(posts.sharingId, originalPostId),
      ),
    });
    const timelineRows = await db.query.timelinePosts.findMany({
      where: eq(timelinePosts.postId, first!.id),
    });
    const originalPost = await db.query.posts.findFirst({
      where: eq(posts.id, originalPostId),
    });
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(sharingPosts).toHaveLength(1);
    expect(timelineRows).toHaveLength(1);
    expect(originalPost?.sharesCount).toBe(1);
  });

  it("does not forward duplicate announces for a local post", async () => {
    expect.assertions(1);
    const { actor, object } = await seedLocalPostShareScenario();
    const { ctx, forwardActivity } = createCtx();

    await onPostShared(
      ctx,
      createAnnounce("https://remote.test/@sharer/announces/1", actor, object),
    );
    await onPostShared(
      ctx,
      createAnnounce("https://remote.test/@sharer/announces/2", actor, object),
    );

    expect(forwardActivity).toHaveBeenCalledOnce();
  });
});

describe("persistPost", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("does not fetch remote replies collections synchronously", async () => {
    expect.assertions(4);
    const author = await seedRemoteAccount("author");
    const repliesIri = "https://remote.test/@author/posts/1/replies";
    const documentLoader = vi.fn(
      async (url: string): Promise<RemoteDocument> => {
        if (url === repliesIri) {
          throw new Error("replies collection was fetched synchronously");
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    const first = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/1"),
        attribution: createPerson(author),
        content: "<p>Hello</p>",
        replies: new URL(repliesIri),
        to: PUBLIC_COLLECTION,
      }),
      "https://hollo.test",
      { account: author, documentLoader },
    );
    const second = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/1"),
        attribution: createPerson(author),
        content: "<p>Hello again</p>",
        replies: new URL(repliesIri),
        to: PUBLIC_COLLECTION,
      }),
      "https://hollo.test",
      { account: author, documentLoader },
    );
    const jobs = await db.query.remoteReplyScrapeJobs.findMany();

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(documentLoader).not.toHaveBeenCalledWith(repliesIri);
    expect(jobs.map((job) => job.repliesIri)).toEqual([repliesIri]);
  });

  it("does not overwrite replies counts during post updates", async () => {
    expect.assertions(2);
    const author = await seedRemoteAccount("author");
    const repliesIri = "https://remote.test/@author/posts/1/replies";

    const first = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/1"),
        attribution: createPerson(author),
        content: "<p>Hello</p>",
        replies: new URL(repliesIri),
        to: PUBLIC_COLLECTION,
      }),
      "https://hollo.test",
      { account: author },
    );
    if (first == null) throw new Error("Failed to persist post");

    await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/1"),
        attribution: new URL(author.iri),
        content: "<p>Hello again</p>",
        replies: new URL(repliesIri),
        to: PUBLIC_COLLECTION,
      }),
      "https://hollo.test",
      {
        documentLoader: async (url): Promise<RemoteDocument> => {
          if (url !== author.iri) throw new Error(`Unexpected fetch: ${url}`);
          await db
            .update(posts)
            .set({ repliesCount: 3 })
            .where(eq(posts.id, first.id));
          return {
            contextUrl: null,
            document: {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: author.iri,
              type: "Person",
              name: author.handle,
              inbox: `${author.iri}/inbox`,
              followers: author.followersUrl,
            },
            documentUrl: url,
          };
        },
      },
    );

    const post = await db.query.posts.findFirst({
      where: eq(posts.id, first.id),
    });
    const jobs = await db.query.remoteReplyScrapeJobs.findMany();
    expect(post?.repliesCount).toBe(3);
    expect(jobs.map((job) => job.repliesIri)).toEqual([repliesIri]);
  });
});

describe("toObject", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function getObjectJson(postId: Uuid) {
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: {
        account: { with: { owner: true } },
        replyTarget: true,
        quoteTarget: true,
        media: true,
        poll: { with: { options: true } },
        mentions: { with: { account: true } },
        replies: true,
      },
    });
    if (post == null) throw new Error("Failed to load post");
    return await toObject(post, {} as Context<unknown>).toJsonLd();
  }

  it("adds a quote-inline fallback to explicit quote content", async () => {
    const account = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quoteTargetUrl = "https://remote.test/@quoted/1";

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: "https://remote.test/objects/1",
        type: "Note",
        accountId: account.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        url: quoteTargetUrl,
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@quote-author/${quotePostId}`,
        type: "Note",
        accountId: account.id as Uuid,
        quoteTargetId: quotedPostId,
        visibility: "public",
        contentHtml: "<p>My take</p>\n",
        content: "My take",
        published: new Date(),
      },
    ]);

    const json = await getObjectJson(quotePostId);

    expect(json).toMatchObject({
      content:
        '<p>My take</p>\n<p class="quote-inline">RE: ' +
        `<a href="${quoteTargetUrl}">${quoteTargetUrl}</a></p>`,
    });
  });

  it("emits quote-inline fallback content for quote-only posts", async () => {
    const account = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quoteTargetUrl = "https://remote.test/@quoted/2";

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: "https://remote.test/objects/2",
        type: "Note",
        accountId: account.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        url: quoteTargetUrl,
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@quote-author/${quotePostId}`,
        type: "Note",
        accountId: account.id as Uuid,
        quoteTargetId: quotedPostId,
        visibility: "public",
        contentHtml: null,
        content: null,
        published: new Date(),
      },
    ]);

    const json = await getObjectJson(quotePostId);

    expect(json).toMatchObject({
      content:
        `<p class="quote-inline">RE: ` +
        `<a href="${quoteTargetUrl}">${quoteTargetUrl}</a></p>`,
    });
  });

  it("does not duplicate quote-inline fallback when content links the quote target", async () => {
    const account = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quoteTargetUrl = "https://remote.test/@quoted/3";
    const contentHtml = `<p>Read <a href="${quoteTargetUrl}">${quoteTargetUrl}</a></p>`;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: "https://remote.test/objects/3",
        type: "Note",
        accountId: account.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        url: quoteTargetUrl,
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@quote-author/${quotePostId}`,
        type: "Note",
        accountId: account.id as Uuid,
        quoteTargetId: quotedPostId,
        visibility: "public",
        contentHtml,
        content: "Read the quoted post",
        published: new Date(),
      },
    ]);

    const json = await getObjectJson(quotePostId);

    expect(json).toMatchObject({ content: contentHtml });
  });

  it("adds a quote-inline fallback when quote-inline appears only as body text", async () => {
    const account = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quoteTargetUrl = "https://remote.test/@quoted/4";
    const contentHtml = "<p>The phrase quote-inline is just text.</p>";

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: "https://remote.test/objects/4",
        type: "Note",
        accountId: account.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        url: quoteTargetUrl,
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@quote-author/${quotePostId}`,
        type: "Note",
        accountId: account.id as Uuid,
        quoteTargetId: quotedPostId,
        visibility: "public",
        contentHtml,
        content: "The phrase quote-inline is just text.",
        published: new Date(),
      },
    ]);

    const json = await getObjectJson(quotePostId);

    expect(json).toMatchObject({
      content:
        `${contentHtml}<p class="quote-inline">RE: ` +
        `<a href="${quoteTargetUrl}">${quoteTargetUrl}</a></p>`,
    });
  });

  it("does not duplicate quote-inline fallback for an escaped query string target link", async () => {
    const account = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quoteTargetUrl = "https://remote.test/@quoted/5?first=1&second=2";
    const contentHtml =
      '<p>Read <a href="https://remote.test/@quoted/5?first=1&#38;second=2">' +
      "the quoted post</a></p>";

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: "https://remote.test/objects/5",
        type: "Note",
        accountId: account.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        url: quoteTargetUrl,
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@quote-author/${quotePostId}`,
        type: "Note",
        accountId: account.id as Uuid,
        quoteTargetId: quotedPostId,
        visibility: "public",
        contentHtml,
        content: "Read the quoted post",
        published: new Date(),
      },
    ]);

    const json = await getObjectJson(quotePostId);

    expect(json).toMatchObject({ content: contentHtml });
  });

  it("emits FEP-044f quote and quote policy fields", async () => {
    const account = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: "https://remote.test/objects/fep-quote-target",
        type: "Note",
        accountId: account.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@quote-author/${quotePostId}`,
        type: "Note",
        accountId: account.id as Uuid,
        quoteTargetId: quotedPostId,
        quoteTargetIri: "https://remote.test/objects/fep-quote-target",
        quoteState: "accepted",
        visibility: "public",
        contentHtml: "<p>My take</p>",
        content: "My take",
        published: new Date(),
      },
    ]);

    const json = await getObjectJson(quotePostId);

    expect(json).toMatchObject({
      quote: "https://remote.test/objects/fep-quote-target",
      quoteUrl: "https://remote.test/objects/fep-quote-target",
      interactionPolicy: {
        canQuote: {
          automaticApproval: "as:Public",
        },
      },
    });
  });
});

describe("persistPost quotes", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists quote targets from the FEP-044f quote property", async () => {
    const author = await seedRemoteAccount("quote-author");
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = "https://remote.test/objects/quoted-with-fep";

    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id,
      visibility: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const persisted = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/objects/quote-with-fep"),
        attribution: createPerson(author),
        quote: new URL(quotedPostIri),
        to: PUBLIC_COLLECTION,
        content: "<p>Quote post</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteTargetId).toBe(quotedPostId);
    expect(persisted?.quoteTargetIri).toBe(quotedPostIri);
    expect(persisted?.quoteState).toBe("accepted");
  });

  it("defaults quote approval to public when no interaction policy exists", async () => {
    const author = await seedRemoteAccount("quote-author");

    const persisted = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/objects/default-quote-policy"),
        attribution: createPerson(author),
        to: PUBLIC_COLLECTION,
        content: "<p>Default quote policy</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteApprovalPolicy).toBe("public");
  });

  it("does not treat manual-only quote approval as public", async () => {
    const author = await seedRemoteAccount("quote-author");

    const persisted = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/objects/manual-quote-policy"),
        attribution: createPerson(author),
        interactionPolicy: new InteractionPolicy({
          canQuote: new InteractionRule({
            manualApproval: PUBLIC_COLLECTION,
          }),
        }),
        to: PUBLIC_COLLECTION,
        content: "<p>Manual quote policy</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteApprovalPolicy).toBe("nobody");
  });

  it("persists followers-only automatic quote approval", async () => {
    const author = await seedRemoteAccount("quote-author");

    const persisted = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/objects/followers-quote-policy"),
        attribution: createPerson(author),
        interactionPolicy: new InteractionPolicy({
          canQuote: new InteractionRule({
            automaticApproval: new URL(author.followersUrl!),
          }),
        }),
        to: PUBLIC_COLLECTION,
        content: "<p>Followers quote policy</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteApprovalPolicy).toBe("followers");
  });
});
