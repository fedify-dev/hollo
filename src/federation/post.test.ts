import type { Context, InboxContext } from "@fedify/fedify";
import {
  Announce,
  InteractionPolicy,
  InteractionRule,
  Mention,
  Note,
  Person,
  PUBLIC_COLLECTION,
  QuoteAuthorization,
  type RemoteDocument,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows, instances, posts } from "../schema";
import type { Uuid } from "../uuid";
import { toTemporalInstant } from "./date";
import { onPostShared } from "./inbox";
import federation from "./index";
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
    where: { id: { eq: id } },
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

async function seedShareScenario(options: { authorHost?: string } = {}) {
  const authorHost = options.authorHost ?? "remote.test";
  const owner = await createAccount({ username: "hollo" });
  const author = await seedRemoteAccountOn(authorHost, "author");
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
  const originalPostIri = `${author.iri}/posts/1`;
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

async function seedRemoteAccountOn(host: string, username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://${host}/@${username}`;
  await db
    .insert(instances)
    .values({
      host,
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  await db.insert(accounts).values({
    id,
    iri,
    type: "Person",
    name: username,
    handle: `@${username}@${host}`,
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${iri}/inbox`,
    followersUrl: `${iri}/followers`,
    sharedInboxUrl: `https://${host}/inbox`,
    featuredUrl: `${iri}/featured`,
    instanceHost: host,
    published: new Date(),
  });
  const account = await db.query.accounts.findFirst({
    where: { id: { eq: id } },
    with: { owner: true },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
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
      where: {
        RAW: (posts, { and, eq }) =>
          and(
            eq(posts.accountId, sharer.id),
            eq(posts.sharingId, originalPostId),
          )!,
      },
    });
    const timelineRows = await db.query.timelinePosts.findMany({
      where: { postId: { eq: first!.id } },
    });
    const originalPost = await db.query.posts.findFirst({
      where: { id: { eq: originalPostId } },
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
      where: {
        RAW: (posts, { and, eq }) =>
          and(
            eq(posts.accountId, sharer.id),
            eq(posts.sharingId, originalPostId),
          )!,
      },
    });
    const timelineRows = await db.query.timelinePosts.findMany({
      where: { postId: { eq: first!.id } },
    });
    const originalPost = await db.query.posts.findFirst({
      where: { id: { eq: originalPostId } },
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

  it("refuses to first-materialize a new post whose attribution claims a different origin", async () => {
    expect.assertions(2);
    // Sharer is on remote.test. The announce embeds a brand-new Note
    // hosted on remote.test (matching the announcer's origin) but the
    // attribution names an actor on victim.test. Without validation,
    // persistPost would dereference victim.test for the attribution
    // and cache the forged content as victim.test/@author's post.
    const sharer = await seedRemoteAccount("sharer");
    const forgedIri = "https://remote.test/@sharer/posts/forged";
    const forgedObject = new Note({
      id: new URL(forgedIri),
      attribution: new Person({
        id: new URL("https://victim.test/@author"),
      }),
      content: "<p>masquerade</p>",
      to: PUBLIC_COLLECTION,
    });

    const share = await persistSharingPost(
      db,
      createAnnounce(
        "https://remote.test/@sharer/announces/forge",
        createPerson(sharer),
        forgedObject,
      ),
      forgedObject,
      "https://hollo.test",
      { account: sharer },
    );

    const inserted = await db.query.posts.findFirst({
      where: { iri: { eq: forgedIri } },
    });
    expect(share).toBeNull();
    expect(inserted).toBeUndefined();
  });

  it("ignores embedded content from a cross-origin announce for a known post", async () => {
    expect.assertions(3);
    // Sharer is on remote.test, author/post are on victim.test (different
    // origin). The embedded Note carries a hijacked body for the known
    // post IRI; the canonical row in the DB must win.
    const { actor, originalPostId, originalPostIri, sharer } =
      await seedShareScenario({ authorHost: "victim.test" });

    const forgedObject = new Note({
      id: new URL(originalPostIri),
      content: "<p>HIJACKED</p>",
      to: PUBLIC_COLLECTION,
    });

    const share = await persistSharingPost(
      db,
      createAnnounce(
        "https://remote.test/@sharer/announces/1",
        actor,
        forgedObject,
      ),
      forgedObject,
      "https://hollo.test",
      { account: sharer },
    );

    const original = await db.query.posts.findFirst({
      where: { id: { eq: originalPostId } },
    });
    expect(share).not.toBeNull();
    // The original post must keep its canonical content, not the
    // attacker-supplied "HIJACKED" version.
    expect(original?.content).toBe("Shared once");
    expect(original?.contentHtml).toBe("<p>Shared once</p>");
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
      where: { id: { eq: first.id } },
    });
    const jobs = await db.query.remoteReplyScrapeJobs.findMany();
    expect(post?.repliesCount).toBe(3);
    expect(jobs.map((job) => job.repliesIri)).toEqual([repliesIri]);
  });

  it("ignores posts with a published date more than 12 hours in the future", async () => {
    expect.assertions(3);
    const author = await seedRemoteAccount("author");
    const futureDate = new Date(Date.now() + 13 * 60 * 60 * 1000);
    const iri = "https://remote.test/@author/posts/future";

    const result = await persistPost(
      db,
      new Note({
        id: new URL(iri),
        attribution: createPerson(author),
        content: "<p>From the future</p>",
        to: PUBLIC_COLLECTION,
        published: toTemporalInstant(futureDate),
      }),
      "https://hollo.test",
      { account: author },
    );
    const row = await db.query.posts.findFirst({
      where: { iri: { eq: iri } },
    });
    const timelineRows = await db.query.timelinePosts.findMany();

    expect(result).toBeNull();
    expect(row).toBeUndefined();
    expect(timelineRows).toHaveLength(0);
  });

  it("ignores posts with an updated date more than 12 hours in the future", async () => {
    expect.assertions(3);
    const author = await seedRemoteAccount("author");
    const futureDate = new Date(Date.now() + 13 * 60 * 60 * 1000);
    const iri = "https://remote.test/@author/posts/future-updated";

    const result = await persistPost(
      db,
      new Note({
        id: new URL(iri),
        attribution: createPerson(author),
        content: "<p>Updated in the future</p>",
        to: PUBLIC_COLLECTION,
        updated: toTemporalInstant(futureDate),
      }),
      "https://hollo.test",
      { account: author },
    );
    const row = await db.query.posts.findFirst({
      where: { iri: { eq: iri } },
    });
    const timelineRows = await db.query.timelinePosts.findMany();

    expect(result).toBeNull();
    expect(row).toBeUndefined();
    expect(timelineRows).toHaveLength(0);
  });

  it("accepts posts with a published date slightly in the future (within 12 hours)", async () => {
    expect.assertions(1);
    const author = await seedRemoteAccount("author");
    const slightlyFutureDate = new Date(Date.now() + 11 * 60 * 60 * 1000);

    const result = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/near-future"),
        attribution: createPerson(author),
        content: "<p>Slightly future</p>",
        to: PUBLIC_COLLECTION,
        published: toTemporalInstant(slightlyFutureDate),
      }),
      "https://hollo.test",
      { account: author },
    );

    expect(result).not.toBeNull();
  });

  it("accepts posts with a pre-epoch timestamp without crashing", async () => {
    expect.assertions(2);
    const author = await seedRemoteAccount("author");
    // 1963-11-22, before Unix epoch (1970-01-01)
    const preEpochDate = new Date("1963-11-22T12:30:00Z");

    const result = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/old-post"),
        attribution: createPerson(author),
        content: "<p>A very old post</p>",
        to: PUBLIC_COLLECTION,
        published: toTemporalInstant(preEpochDate),
      }),
      "https://hollo.test",
      { account: author },
    );

    expect(result).not.toBeNull();
    expect(result?.published).toEqual(preEpochDate);
  });

  it("does not treat remote mention profile links as preview-card links", async () => {
    expect.assertions(3);
    const author = await seedRemoteAccount("author");
    const mentioned = await seedRemoteAccount("mentioned");
    const mentionedProfileUrl = "https://remote.test/users/mentioned";
    await db
      .update(accounts)
      .set({ url: mentionedProfileUrl })
      .where(eq(accounts.id, mentioned.id));

    const result = await persistPost(
      db,
      new Note({
        id: new URL("https://remote.test/@author/posts/mention-only"),
        attribution: createPerson(author),
        content:
          `<p><a href="${mentionedProfileUrl}">` +
          "@<bdi>mentioned@remote.test</bdi></a> hello</p>",
        tags: [
          new Mention({
            href: new URL(mentioned.iri),
            name: mentioned.handle,
          }),
        ],
        to: PUBLIC_COLLECTION,
      }),
      "https://hollo.test",
      { account: author },
    );
    if (result == null) throw new Error("Failed to persist post");

    const post = await db.query.posts.findFirst({
      where: { id: { eq: result.id } },
    });
    const mentionRows = await db.query.mentions.findMany({
      where: { postId: { eq: result.id } },
    });

    expect(result).not.toBeNull();
    expect(post?.previewCard).toBeNull();
    expect(mentionRows).toEqual([
      { accountId: mentioned.id, postId: result.id },
    ]);
  });
});

describe("toObject", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function getObjectJson(postId: Uuid) {
    return await getObjectJsonWithContext(postId);
  }

  async function getObjectJsonWithContext(
    postId: Uuid,
    ctxOverrides: Partial<Context<unknown>> = {},
  ) {
    const post = await db.query.posts.findFirst({
      where: { id: { eq: postId } },
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
    const ctx = Object.assign(
      federation.createContext(new Request("https://hollo.test/"), undefined),
      ctxOverrides,
    );
    return await toObject(post, ctx).toJsonLd();
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

  it.each(["pending", "rejected", "revoked", "unauthorized"] as const)(
    "omits quote fields for %s quotes",
    async (quoteState) => {
      expect.assertions(3);

      const account = await createAccount({ username: "quote-author" });
      const quotedPostId = crypto.randomUUID() as Uuid;
      const quotePostId = crypto.randomUUID() as Uuid;

      await db.insert(posts).values([
        {
          id: quotedPostId,
          iri: "https://remote.test/objects/inactive-quote-target",
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
          quoteTargetIri: "https://remote.test/objects/inactive-quote-target",
          quoteState,
          visibility: "public",
          contentHtml: "<p>My inactive quote</p>",
          content: "My inactive quote",
          published: new Date(),
        },
      ]);

      const json = await getObjectJson(quotePostId);

      expect(json).not.toHaveProperty("quote");
      expect(json).not.toHaveProperty("quoteUrl");
      expect(JSON.stringify(json)).not.toContain("inactive-quote-target");
    },
  );

  it("emits author-only quote policy for private statuses", async () => {
    expect.assertions(1);

    const account = await createAccount({ username: "quote-author" });
    const postId = crypto.randomUUID() as Uuid;

    await db.insert(posts).values({
      id: postId,
      iri: `https://hollo.test/@quote-author/${postId}`,
      type: "Note",
      accountId: account.id as Uuid,
      visibility: "private",
      quoteApprovalPolicy: "followers",
      contentHtml: "<p>Followers cannot quote this</p>",
      content: "Followers cannot quote this",
      published: new Date(),
    });

    const json = await getObjectJsonWithContext(postId, {
      getFollowersUri: (handle: string) =>
        new URL(`https://hollo.test/@${handle}/followers`),
    } as Context<unknown>);

    expect(json).toMatchObject({
      interactionPolicy: {
        canQuote: {
          automaticApproval: "https://hollo.test/@quote-author",
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

  it("does not accept quotes with forged quote authorization", async () => {
    expect.assertions(3);

    const author = await seedRemoteAccount("quote-author");
    const quoter = await seedRemoteAccount("quote-quoter");
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = "https://remote.test/objects/quoted-forged-auth";
    const quotePostIri = "https://remote.test/objects/quote-forged-auth";
    const quoteAuthorizationIri = `${quotedPostIri}/quote_authorizations/forged`;

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
        id: new URL(quotePostIri),
        attribution: createPerson(quoter),
        quote: new URL(quotedPostIri),
        quoteAuthorization: new QuoteAuthorization({
          id: new URL(quoteAuthorizationIri),
          attribution: new URL(quoter.iri),
          interactingObject: new URL(quotePostIri),
          interactionTarget: new URL(quotedPostIri),
        }),
        to: PUBLIC_COLLECTION,
        content: "<p>Quote post</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteTargetId).toBe(quotedPostId);
    expect(persisted?.quoteState).toBe("unauthorized");
    expect(persisted?.quoteAuthorizationIri).toBeNull();
  });

  it("preserves accepted quote authorization during later updates", async () => {
    expect.assertions(3);

    const author = await seedRemoteAccount("quote-author");
    const quoter = await seedRemoteAccount("quote-quoter");
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = "https://remote.test/objects/quoted-later-update";
    const quotePostIri = "https://remote.test/objects/quote-later-update";
    const quoteAuthorizationIri = `${quotedPostIri}/quote_authorizations/${quotePostId}`;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: quotePostIri,
        type: "Note",
        accountId: quoter.id,
        quoteTargetId: quotedPostId,
        quoteTargetIri: quotedPostIri,
        quoteState: "accepted",
        quoteAuthorizationIri,
        visibility: "public",
        contentHtml: "<p>Original quote</p>",
        content: "Original quote",
        published: new Date(),
      },
    ]);

    const persisted = await persistPost(
      db,
      new Note({
        id: new URL(quotePostIri),
        attribution: createPerson(quoter),
        quote: new URL(quotedPostIri),
        to: PUBLIC_COLLECTION,
        content: "<p>Updated quote</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteState).toBe("accepted");
    expect(persisted?.quoteAuthorizationIri).toBe(quoteAuthorizationIri);
    expect(persisted?.contentHtml).toBe("<p>Updated quote</p>");
  });

  it("preserves accepted legacy quotes during later updates", async () => {
    expect.assertions(3);

    const author = await seedRemoteAccount("quote-author");
    const quoter = await seedRemoteAccount("quote-quoter");
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = "https://remote.test/objects/quoted-legacy-update";
    const quotePostIri = "https://remote.test/objects/quote-legacy-update";

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: quotePostIri,
        type: "Note",
        accountId: quoter.id,
        quoteTargetId: quotedPostId,
        quoteTargetIri: quotedPostIri,
        quoteState: "accepted",
        quoteAuthorizationIri: null,
        visibility: "public",
        contentHtml: "<p>Original quote</p>",
        content: "Original quote",
        published: new Date(),
      },
    ]);

    const persisted = await persistPost(
      db,
      new Note({
        id: new URL(quotePostIri),
        attribution: createPerson(quoter),
        quote: new URL(quotedPostIri),
        to: PUBLIC_COLLECTION,
        content: "<p>Updated quote</p>",
      }),
      "https://hollo.test",
    );

    expect(persisted?.quoteState).toBe("accepted");
    expect(persisted?.quoteAuthorizationIri).toBeNull();
    expect(persisted?.contentHtml).toBe("<p>Updated quote</p>");
  });

  it("stores no quote approval policy when no interaction policy exists", async () => {
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

    expect(persisted?.quoteApprovalPolicy).toBeNull();
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
