import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  Create,
  Delete,
  type DocumentLoader,
  Note,
  Person,
  QuoteAuthorization,
  QuoteRequest,
  Reject,
  Update,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import {
  accounts,
  blocks,
  follows,
  instances,
  mentions,
  posts,
} from "../schema";
import type { Uuid } from "../uuid";
import {
  onFollowAccepted,
  onFollowRejected,
  onPostCreated,
  onPostUpdated,
  onQuoteAuthorizationDeleted,
  onQuoteRequestAccepted,
  onQuoteRequested,
  onQuoteRequestRejected,
  sendQuoteUpdate,
} from "./inbox";
import federation from "./index";
import { persistPost } from "./post";

type SeededFollow = {
  followerId: Uuid;
  followingId: Uuid;
  followerIri: string;
  followingIri: string;
};

async function seedFollow(): Promise<SeededFollow> {
  const followerOwner = await createAccount({ username: "follower" });
  const followingOwner = await createAccount({ username: "following" });
  const follower = await db.query.accounts.findFirst({
    where: { id: { eq: followerOwner.id as Uuid } },
  });
  const following = await db.query.accounts.findFirst({
    where: { id: { eq: followingOwner.id as Uuid } },
  });
  if (follower == null || following == null) {
    throw new Error("Failed to seed accounts");
  }
  const followIri = `${follower.iri}#follows/${crypto.randomUUID()}`;
  await db.insert(follows).values({
    iri: followIri,
    followerId: follower.id,
    followingId: following.id,
    approved: null,
  });
  return {
    followerId: follower.id,
    followingId: following.id,
    followerIri: follower.iri,
    followingIri: following.iri,
  };
}

const fedCtx = federation.createContext(
  new URL("https://hollo.test"),
  undefined,
);

// Documents served by the mock document loader, keyed by URL.  Other
// *.test URLs answer 404; JSON-LD contexts come from Fedify's preloaded set.
const remoteDocuments = new Map<string, unknown>();

function notFound(url: string): Error {
  return Object.assign(new Error(`HTTP 404: ${url}`), {
    response: new Response(null, { status: 404 }),
  });
}

const documentLoader: DocumentLoader = async (url, options) => {
  const document = remoteDocuments.get(url);
  if (document != null) return { contextUrl: null, document, documentUrl: url };
  if (new URL(url).hostname.endsWith(".test")) throw notFound(url);
  return await fedCtx.contextLoader(url, options);
};

const ctx = {
  origin: "https://hollo.test",
  recipient: "follower",
  documentLoader,
  contextLoader: fedCtx.contextLoader,
  getFollowersUri: (identifier: string) => fedCtx.getFollowersUri(identifier),
} as unknown as InboxContext<void>;

async function serveQuoteAuthorization(
  authorizationIri: string,
  targetAuthorIri: string,
  quoteIri: string,
  targetIri: string,
): Promise<void> {
  const authorization = new QuoteAuthorization({
    id: new URL(authorizationIri),
    attribution: new URL(targetAuthorIri),
    interactingObject: new URL(quoteIri),
    interactionTarget: new URL(targetIri),
  });
  remoteDocuments.set(
    authorizationIri,
    await authorization.toJsonLd({ contextLoader: fedCtx.contextLoader }),
  );
}

describe("onFollowAccepted", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("approves a pending follow from embedded Follow object", async () => {
    expect.assertions(2);

    const seeded = await seedFollow();
    const accept = await Accept.fromJsonLd({
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: `${seeded.followingIri}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: {
        id: seeded.followingIri,
        type: "Person",
        preferredUsername: "following",
        inbox: `${seeded.followingIri}/inbox`,
      },
      object: {
        id: `${seeded.followerIri}#follows/${crypto.randomUUID()}`,
        type: "Follow",
        actor: seeded.followerIri,
        object: seeded.followingIri,
      },
    });

    await onFollowAccepted(ctx, accept);

    const follow = await db.query.follows.findFirst({
      where: {
        RAW: (follows, { and, eq }) =>
          and(
            eq(follows.followerId, seeded.followerId),
            eq(follows.followingId, seeded.followingId),
          )!,
      },
    });
    expect(follow).toBeDefined();
    expect(follow?.approved).not.toBeNull();
  });

  it("updates the follower's followingCount when approved via embedded Follow object (Path B)", async () => {
    expect.assertions(2);

    const seeded = await seedFollow();

    const followerBefore = await db.query.accounts.findFirst({
      where: { id: { eq: seeded.followerId } },
    });
    expect(followerBefore?.followingCount).toBe(0);

    // Path B: Accept wraps a Follow object whose id does NOT match any stored
    // follow IRI, so the objectId-based lookup (Path A) finds nothing and falls
    // through to the embedded-object fallback.
    const accept = await Accept.fromJsonLd({
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: `${seeded.followingIri}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: {
        id: seeded.followingIri,
        type: "Person",
        preferredUsername: "following",
        inbox: `${seeded.followingIri}/inbox`,
      },
      object: {
        id: `${seeded.followerIri}#follows/${crypto.randomUUID()}`,
        type: "Follow",
        actor: seeded.followerIri,
        object: seeded.followingIri,
      },
    });

    await onFollowAccepted(ctx, accept);

    const followerAfter = await db.query.accounts.findFirst({
      where: { id: { eq: seeded.followerId } },
    });
    expect(followerAfter?.followingCount).toBe(1);
  });
});

describe("onFollowRejected", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deletes a pending follow from embedded Follow object", async () => {
    expect.assertions(1);

    const seeded = await seedFollow();
    const reject = await Reject.fromJsonLd({
      "@context": ["https://www.w3.org/ns/activitystreams"],
      id: `${seeded.followingIri}#rejects/${crypto.randomUUID()}`,
      type: "Reject",
      actor: {
        id: seeded.followingIri,
        type: "Person",
        preferredUsername: "following",
        inbox: `${seeded.followingIri}/inbox`,
      },
      object: {
        id: `${seeded.followerIri}#follows/${crypto.randomUUID()}`,
        type: "Follow",
        actor: seeded.followerIri,
        object: seeded.followingIri,
      },
    });

    await onFollowRejected(ctx, reject);

    const follow = await db.query.follows.findFirst({
      where: {
        RAW: (follows, { and, eq }) =>
          and(
            eq(follows.followerId, seeded.followerId),
            eq(follows.followingId, seeded.followingId),
          )!,
      },
    });
    expect(follow).toBeUndefined();
  });
});

describe("quote request lifecycle", () => {
  beforeEach(async () => {
    await cleanDatabase();
    remoteDocuments.clear();
  });

  async function seedRemoteAccount(username: string): Promise<Uuid> {
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

    return id;
  }

  async function seedPendingQuote() {
    const author = await createAccount({ username: "quote-author" });
    const quoter = await createAccount({ username: "quote-quoter" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotePostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = `https://hollo.test/@quote-quoter/${quotePostId}`;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id as Uuid,
        visibility: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: quotePostIri,
        type: "Note",
        accountId: quoter.id as Uuid,
        quoteTargetId: quotedPostId,
        quoteTargetIri: quotedPostIri,
        quoteState: "pending",
        visibility: "public",
        contentHtml: "<p>Quote post</p>",
        content: "Quote post",
        published: new Date(),
      },
    ]);

    await serveQuoteAuthorization(
      `${quotedPostIri}/quote_authorizations/${quotePostId}`,
      "https://hollo.test/@quote-author",
      quotePostIri,
      quotedPostIri,
    );

    return { quotedPostId, quotedPostIri, quotePostId, quotePostIri };
  }

  it("marks a pending quote accepted from Accept<QuoteRequest>", async () => {
    expect.assertions(3);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
      result: new URL(authorizationIri),
    });

    await onQuoteRequestAccepted(requestCtx, accept);

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(authorizationIri);
    expect(quoted?.quotesCount).toBe(1);
  });

  it("ignores Accept<QuoteRequest> without a QuoteAuthorization result", async () => {
    expect.assertions(4);

    const seeded = await seedPendingQuote();
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
    });

    const accepted = await onQuoteRequestAccepted(ctx, accept);

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(accepted).toBe(false);
    expect(quote?.quoteState).toBe("pending");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
  });

  it("federates the quote update after Accept<QuoteRequest>", async () => {
    expect.assertions(10);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
      result: new URL(authorizationIri),
    });

    const accepted = await onQuoteRequestAccepted(requestCtx, accept);

    expect(accepted).toBe(true);
    expect(sendActivity).toHaveBeenCalledOnce();
    const [sender, recipient, activity] = sendActivity.mock
      .calls[0] as unknown as [unknown, unknown, unknown];
    expect(sender).toEqual({ username: "quote-quoter" });
    expect(recipient).toBe("followers");
    expect(activity).toBeInstanceOf(Update);
    const object = await (activity as Update).getObject();
    expect(object).toBeInstanceOf(Note);
    expect((object as Note).quoteAuthorizationId?.href).toBe(authorizationIri);
    const json = (await object!.toJsonLd()) as Record<string, unknown>;
    expect(json.quote).toBe(seeded.quotedPostIri);
    expect(json.quoteUrl).toBe(seeded.quotedPostIri);
    expect(json.content).toContain('class="quote-inline"');
  });

  it("marks a pending quote accepted from Accept<QuoteRequest IRI>", async () => {
    expect.assertions(3);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new URL(`${seeded.quotePostIri}#quote-request`),
      result: new URL(authorizationIri),
    });

    await onQuoteRequestAccepted(requestCtx, accept);

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(authorizationIri);
    expect(quoted?.quotesCount).toBe(1);
  });

  it("marks a pending quote accepted from Accept<QuoteRequest id>", async () => {
    expect.assertions(3);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        id: new URL(`${seeded.quotePostIri}#quote-request`),
        object: new URL(seeded.quotedPostIri),
      }),
      result: new URL(authorizationIri),
    });

    await onQuoteRequestAccepted(requestCtx, accept);

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(authorizationIri);
    expect(quoted?.quotesCount).toBe(1);
  });

  it("ignores quote request responses from another actor", async () => {
    expect.assertions(3);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-quoter"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
      result: new URL(authorizationIri),
    });
    const reject = new Reject({
      actor: new URL("https://hollo.test/@quote-quoter"),
      object: new URL(`${seeded.quotePostIri}#quote-request`),
    });

    await onQuoteRequestAccepted(ctx, accept);
    await onQuoteRequestRejected(ctx, reject);

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("pending");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
  });

  it("marks a pending quote rejected from Reject<QuoteRequest>", async () => {
    expect.assertions(2);

    const seeded = await seedPendingQuote();
    const reject = new Reject({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
    });

    await onQuoteRequestRejected(
      {
        ...ctx,
        sendActivity: vi.fn(async () => undefined),
      } as unknown as InboxContext<void>,
      reject,
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quoted?.quotesCount).toBe(0);
  });

  it("marks a pending quote rejected from Reject<QuoteRequest IRI>", async () => {
    expect.assertions(2);

    const seeded = await seedPendingQuote();
    const reject = new Reject({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new URL(`${seeded.quotePostIri}#quote-request`),
    });

    await onQuoteRequestRejected(
      {
        ...ctx,
        sendActivity: vi.fn(async () => undefined),
      } as unknown as InboxContext<void>,
      reject,
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quoted?.quotesCount).toBe(0);
  });

  it("marks a pending quote rejected from Reject<QuoteRequest id>", async () => {
    expect.assertions(2);

    const seeded = await seedPendingQuote();
    const reject = new Reject({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        id: new URL(`${seeded.quotePostIri}#quote-request`),
        object: new URL(seeded.quotedPostIri),
      }),
    });

    await onQuoteRequestRejected(
      {
        ...ctx,
        sendActivity: vi.fn(async () => undefined),
      } as unknown as InboxContext<void>,
      reject,
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quoted?.quotesCount).toBe(0);
  });

  it.each(["public", "followers"] as const)(
    "clears a speculative quote after rejection even when target policy is %s",
    async (quoteApprovalPolicy) => {
      const seeded = await seedPendingQuote();
      const recipientId = await seedRemoteAccount("quote-recipient");
      await db
        .insert(mentions)
        .values({ postId: seeded.quotePostId, accountId: recipientId });
      const sendActivity = vi.fn(async () => undefined);
      const requestCtx = {
        ...ctx,
        sendActivity,
      } as unknown as InboxContext<void>;
      await sendQuoteUpdate(requestCtx, seeded.quotePostIri);
      const initial = sendActivity.mock.calls[0] as unknown as [
        unknown,
        unknown,
        Update,
      ];
      const initialObject = await initial[2].getObject();
      expect(await initialObject!.toJsonLd()).toMatchObject({
        quoteUrl: seeded.quotedPostIri,
      });
      sendActivity.mockClear();
      await db
        .update(posts)
        .set({ quoteApprovalPolicy })
        .where(eq(posts.id, seeded.quotedPostId));

      const handled = await onQuoteRequestRejected(
        requestCtx,
        new Reject({
          actor: new URL("https://hollo.test/@quote-author"),
          object: new QuoteRequest({
            object: new URL(seeded.quotedPostIri),
            instrument: new URL(seeded.quotePostIri),
          }),
        }),
      );
      expect(handled).toBe(true);
      expect(sendActivity).toHaveBeenCalledTimes(2);
      const calls = sendActivity.mock.calls as unknown as [
        unknown,
        unknown,
        Update,
        { orderingKey: string },
      ][];
      expect(calls[0][1]).toEqual([
        expect.objectContaining({
          id: new URL("https://remote.test/@quote-recipient"),
        }),
      ]);
      expect(calls[1][1]).toBe("followers");
      for (const [sender, , activity, options] of calls) {
        expect(sender).toEqual({ username: "quote-quoter" });
        expect(options.orderingKey).toBe(`post:${seeded.quotePostIri}`);
        const object = await activity.getObject();
        const json = (await object!.toJsonLd()) as Record<string, unknown>;
        expect(json).not.toHaveProperty("quote");
        expect(json).not.toHaveProperty("quoteUrl");
        expect(json).not.toHaveProperty("quoteAuthorization");
        expect(json.content).toBe("<p>Quote post</p>");
      }
    },
  );

  it("retries a clearing Update after rejection was committed but enqueue failed", async () => {
    const seeded = await seedPendingQuote();
    const sendActivity = vi
      .fn()
      .mockRejectedValueOnce(new Error("Queue unavailable"))
      .mockResolvedValue(undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    const reject = new Reject({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
    });
    await expect(onQuoteRequestRejected(requestCtx, reject)).rejects.toThrow(
      "Queue unavailable",
    );
    const beforeRetry = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    expect(beforeRetry?.quoteState).toBe("rejected");
    expect(await onQuoteRequestRejected(requestCtx, reject)).toBe(true);
    expect(await onQuoteRequestRejected(requestCtx, reject)).toBe(true);
    expect(sendActivity).toHaveBeenCalledTimes(3);
    const afterRetry = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    expect(afterRetry).toEqual(beforeRetry);
    const target = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(target?.quotesCount).toBe(0);
    const firstId = (sendActivity.mock.calls[0][2] as Update).id?.href;
    for (const call of sendActivity.mock.calls) {
      const activity = call[2] as Update;
      expect(activity.id?.href).toBe(firstId);
      const object = await activity.getObject();
      const json = (await object!.toJsonLd()) as Record<string, unknown>;
      expect(json).not.toHaveProperty("quoteUrl");
      expect(json).not.toHaveProperty("quote");
    }
    expect(
      await onQuoteRequestRejected(
        requestCtx,
        reject.clone({ actor: new URL("https://remote.test/@forged") }),
      ),
    ).toBe(false);
    expect(
      await onQuoteRequestRejected(
        requestCtx,
        reject.clone({
          object: new QuoteRequest({
            object: new URL("https://hollo.test/other-target"),
            instrument: new URL(seeded.quotePostIri),
          }),
        }),
      ),
    ).toBe(false);
    expect(
      await onQuoteRequestAccepted(
        requestCtx,
        new Accept({
          actor: reject.actorId,
          object:
            reject.objectId ??
            new QuoteRequest({
              object: new URL(seeded.quotedPostIri),
              instrument: new URL(seeded.quotePostIri),
            }),
          result: new URL(`${seeded.quotedPostIri}/authorization`),
        }),
      ),
    ).toBe(false);
    expect(sendActivity).toHaveBeenCalledTimes(3);
  });

  it("does not clear an accepted quote in response to a late Reject", async () => {
    const seeded = await seedPendingQuote();
    await db
      .update(posts)
      .set({ quoteState: "accepted" })
      .where(eq(posts.id, seeded.quotePostId));
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    expect(
      await onQuoteRequestRejected(
        requestCtx,
        new Reject({
          actor: new URL("https://hollo.test/@quote-author"),
          object: new QuoteRequest({
            object: new URL(seeded.quotedPostIri),
            instrument: new URL(seeded.quotePostIri),
          }),
        }),
      ),
    ).toBe(false);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("marks an accepted quote revoked when its authorization is deleted", async () => {
    expect.assertions(2);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const requestCtx = {
      ...ctx,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as InboxContext<void>;
    await db
      .update(posts)
      .set({
        quoteState: "accepted",
        quoteAuthorizationIri: authorizationIri,
        quotesCount: 1,
      })
      .where(eq(posts.id, seeded.quotePostId));
    await db
      .update(posts)
      .set({ quotesCount: 1 })
      .where(eq(posts.id, seeded.quotedPostId));

    await onQuoteAuthorizationDeleted(
      requestCtx,
      new Delete({
        actor: new URL("https://hollo.test/@quote-author"),
        object: new QuoteAuthorization({
          id: new URL(authorizationIri),
          attribution: new URL("https://hollo.test/@quote-author"),
          interactingObject: new URL(seeded.quotePostIri),
          interactionTarget: new URL(seeded.quotedPostIri),
        }),
      }),
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("revoked");
    expect(quoted?.quotesCount).toBe(0);
  });

  it("federates the quote update after authorization deletion", async () => {
    expect.assertions(10);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;
    await db
      .update(posts)
      .set({
        quoteState: "accepted",
        quoteAuthorizationIri: authorizationIri,
        quotesCount: 1,
      })
      .where(eq(posts.id, seeded.quotePostId));
    await db
      .update(posts)
      .set({ quotesCount: 1 })
      .where(eq(posts.id, seeded.quotedPostId));

    await onQuoteAuthorizationDeleted(
      requestCtx,
      new Delete({
        actor: new URL("https://hollo.test/@quote-author"),
        object: new QuoteAuthorization({
          id: new URL(authorizationIri),
          attribution: new URL("https://hollo.test/@quote-author"),
          interactingObject: new URL(seeded.quotePostIri),
          interactionTarget: new URL(seeded.quotedPostIri),
        }),
      }),
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    expect(quote?.quoteState).toBe("revoked");
    expect(sendActivity).toHaveBeenCalledOnce();
    const [sender, recipient, activity] = sendActivity.mock
      .calls[0] as unknown as [unknown, unknown, unknown];
    expect(sender).toEqual({ username: "quote-quoter" });
    expect(recipient).toBe("followers");
    expect(activity).toBeInstanceOf(Update);
    const object = await (activity as Update).getObject();
    expect(object).toBeInstanceOf(Note);
    expect((object as Note).quoteAuthorizationId).toBeNull();
    const json = (await object!.toJsonLd()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("quote");
    expect(json).not.toHaveProperty("quoteUrl");
    expect(json.content).not.toContain('class="quote-inline"');
  });

  it("marks an accepted quote revoked from a deleted authorization IRI", async () => {
    expect.assertions(2);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    const requestCtx = {
      ...ctx,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as InboxContext<void>;
    await db
      .update(posts)
      .set({
        quoteState: "accepted",
        quoteAuthorizationIri: authorizationIri,
        quotesCount: 1,
      })
      .where(eq(posts.id, seeded.quotePostId));
    await db
      .update(posts)
      .set({ quotesCount: 1 })
      .where(eq(posts.id, seeded.quotedPostId));

    await onQuoteAuthorizationDeleted(
      requestCtx,
      new Delete({
        actor: new URL("https://hollo.test/@quote-author"),
        object: new URL(authorizationIri),
      }),
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("revoked");
    expect(quoted?.quotesCount).toBe(0);
  });

  it("ignores quote authorization deletion from another actor", async () => {
    expect.assertions(3);

    const seeded = await seedPendingQuote();
    const authorizationIri = `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
    await db
      .update(posts)
      .set({
        quoteState: "accepted",
        quoteAuthorizationIri: authorizationIri,
        quotesCount: 1,
      })
      .where(eq(posts.id, seeded.quotePostId));
    await db
      .update(posts)
      .set({ quotesCount: 1 })
      .where(eq(posts.id, seeded.quotedPostId));

    await onQuoteAuthorizationDeleted(
      ctx,
      new Delete({
        actor: new URL("https://hollo.test/@quote-quoter"),
        object: new QuoteAuthorization({
          id: new URL(authorizationIri),
          attribution: new URL("https://hollo.test/@quote-author"),
          interactingObject: new URL(seeded.quotePostIri),
          interactionTarget: new URL(seeded.quotedPostIri),
        }),
      }),
    );

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(authorizationIri);
    expect(quoted?.quotesCount).toBe(1);
  });

  it("accepts an allowed QuoteRequest for a local post", async () => {
    expect.assertions(4);

    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-1";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteTargetId).toBe(quotedPostId);
    expect(quoted?.quotesCount).toBe(1);
    expect(sendActivity).toHaveBeenCalledOnce();
  });

  it("ignores a QuoteRequest for an existing quote owned by another actor", async () => {
    expect.assertions(5);

    const author = await createAccount({ username: "quote-author" });
    const localQuoter = await createAccount({ username: "local-quoter" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const localQuotePostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const localQuotePostIri = `https://hollo.test/@local-quoter/${localQuotePostId}`;
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id as Uuid,
        visibility: "public",
        quoteApprovalPolicy: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        published: new Date(),
      },
      {
        id: localQuotePostId,
        iri: localQuotePostIri,
        type: "Note",
        accountId: localQuoter.id as Uuid,
        quoteTargetIri: quotedPostIri,
        quoteState: "unauthorized",
        visibility: "public",
        contentHtml: "<p>Local quote</p>",
        content: "Local quote",
        published: new Date(),
      },
    ]);

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@attacker"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(localQuotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@attacker"),
          name: "attacker",
          preferredUsername: "attacker",
          inbox: new URL("https://remote.test/@attacker/inbox"),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Forged quote request</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { id: { eq: localQuotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote?.quoteState).toBe("unauthorized");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quote?.accountId).toBe(localQuoter.id);
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("creates a quote notification for accepted QuoteRequests", async () => {
    expect.assertions(5);

    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-notified";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
      with: { account: true },
    });
    if (quote == null) throw new Error("Failed to persist quote");
    const notification = await db.query.notifications.findFirst({
      where: {
        RAW: (notifications, { and, eq }) =>
          and(
            eq(notifications.type, "quote"),
            eq(notifications.accountOwnerId, author.id as Uuid),
            eq(notifications.actorAccountId, quote.accountId),
            eq(notifications.targetPostId, quote.id),
          )!,
      },
    });

    expect(quote.quoteState).toBe("accepted");
    expect(quote.account.iri).toBe("https://remote.test/@quoter");
    expect(notification).toBeDefined();
    expect(notification?.targetPostId).toBe(quote.id);
    expect(sendActivity).toHaveBeenCalledOnce();
  });

  it("keeps repeated QuoteRequest deliveries idempotent for accepted quotes", async () => {
    expect.assertions(4);

    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-1";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);
    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(
      `${quotedPostIri}/quote_authorizations/${quote?.id}`,
    );
    expect(quoted?.quotesCount).toBe(1);
    expect(sendActivity).toHaveBeenCalledTimes(2);
  });

  it("recomputes quote counts when accepted quotes are retargeted", async () => {
    expect.assertions(6);

    const author = await createAccount({ username: "quote-author" });
    const oldPostId = crypto.randomUUID() as Uuid;
    const newPostId = crypto.randomUUID() as Uuid;
    const oldPostIri = `https://hollo.test/@quote-author/${oldPostId}`;
    const newPostIri = `https://hollo.test/@quote-author/${newPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-retargeted";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values([
      {
        id: oldPostId,
        iri: oldPostIri,
        type: "Note",
        accountId: author.id as Uuid,
        visibility: "public",
        quoteApprovalPolicy: "public",
        contentHtml: "<p>Old quoted post</p>",
        content: "Old quoted post",
        published: new Date(),
      },
      {
        id: newPostId,
        iri: newPostIri,
        type: "Note",
        accountId: author.id as Uuid,
        visibility: "public",
        quoteApprovalPolicy: "public",
        contentHtml: "<p>New quoted post</p>",
        content: "New quoted post",
        published: new Date(),
      },
    ]);

    const oldRequest = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(oldPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(oldPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });
    const newRequest = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(newPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(newPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote retargeted</p>",
      }),
    });

    await onQuoteRequested(requestCtx, oldRequest);
    await onQuoteRequested(requestCtx, newRequest);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const oldPost = await db.query.posts.findFirst({
      where: { id: { eq: oldPostId } },
    });
    const newPost = await db.query.posts.findFirst({
      where: { id: { eq: newPostId } },
    });
    expect(quote?.quoteTargetId).toBe(newPostId);
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(
      `${newPostIri}/quote_authorizations/${quote?.id}`,
    );
    expect(oldPost?.quotesCount).toBe(0);
    expect(newPost?.quotesCount).toBe(1);
    expect(sendActivity).toHaveBeenCalledTimes(2);
  });

  it("preserves revoked quotes when QuoteRequests are retried", async () => {
    expect.assertions(4);

    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-retried";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);
    const acceptedQuote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    if (acceptedQuote == null) throw new Error("Failed to persist quote");
    await db
      .update(posts)
      .set({
        quoteState: "revoked",
        quoteAuthorizationIri: null,
        updated: new Date(),
      })
      .where(eq(posts.id, acceptedQuote.id));
    await db
      .update(posts)
      .set({ quotesCount: 0 })
      .where(eq(posts.id, quotedPostId));
    sendActivity.mockClear();

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote?.quoteState).toBe("revoked");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("rejects a private QuoteRequest from an approved follower", async () => {
    expect.assertions(4);

    const author = await createAccount({ username: "quote-author" });
    const quoterIri = "https://remote.test/@quoter";
    const quoterId = await seedRemoteAccount("quoter");
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-private";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(follows).values({
      iri: `${quoterIri}#follows/${crypto.randomUUID()}`,
      followingId: author.id as Uuid,
      followerId: quoterId,
      approved: new Date(),
    });
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "private",
      quoteApprovalPolicy: "followers",
      contentHtml: "<p>Private quoted post</p>",
      content: "Private quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL(quoterIri),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL(quoterIri),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL(`${quoterIri}/inbox`),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote of a private post</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).toHaveBeenCalledOnce();
  });

  it("rejects a QuoteRequest from a blocked account", async () => {
    expect.assertions(4);

    const author = await createAccount({ username: "quote-author" });
    const blockedAccountId = crypto.randomUUID() as Uuid;
    const blockedAccountIri = "https://remote.test/@blocked";
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@blocked/quote-1";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();
    await db.insert(accounts).values({
      id: blockedAccountId,
      iri: blockedAccountIri,
      type: "Person",
      name: "blocked",
      handle: "@blocked@remote.test",
      bioHtml: "",
      protected: false,
      inboxUrl: `${blockedAccountIri}/inbox`,
      instanceHost: "remote.test",
    });
    await db.insert(blocks).values({
      accountId: author.id as Uuid,
      blockedAccountId,
    });
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL(blockedAccountIri),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL(blockedAccountIri),
          name: "blocked",
          preferredUsername: "blocked",
          inbox: new URL(`${blockedAccountIri}/inbox`),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Blocked quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).toHaveBeenCalledOnce();
  });

  it("ignores a QuoteRequest whose actor does not match the quote", async () => {
    expect.assertions(3);

    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-1";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy: "public",
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@attacker"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(quotedPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote).toBeUndefined();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("ignores a QuoteRequest whose quote targets another object", async () => {
    expect.assertions(3);

    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const otherPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    const otherPostIri = `https://hollo.test/@quote-author/${otherPostId}`;
    const quotePostIri = "https://remote.test/@quoter/quote-1";
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      sendActivity,
    } as unknown as InboxContext<void>;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostIri,
        type: "Note",
        accountId: author.id as Uuid,
        visibility: "public",
        quoteApprovalPolicy: "public",
        contentHtml: "<p>Quoted post</p>",
        content: "Quoted post",
        published: new Date(),
      },
      {
        id: otherPostId,
        iri: otherPostIri,
        type: "Note",
        accountId: author.id as Uuid,
        visibility: "public",
        quoteApprovalPolicy: "public",
        contentHtml: "<p>Other post</p>",
        content: "Other post",
        published: new Date(),
      },
    ]);

    const request = new QuoteRequest({
      id: new URL(`https://remote.test/quote-requests/${crypto.randomUUID()}`),
      actor: new URL("https://remote.test/@quoter"),
      object: new URL(quotedPostIri),
      instrument: new Note({
        id: new URL(quotePostIri),
        attribution: new Person({
          id: new URL("https://remote.test/@quoter"),
          name: "quoter",
          preferredUsername: "quoter",
          inbox: new URL("https://remote.test/@quoter/inbox"),
        }),
        quote: new URL(otherPostIri),
        to: new URL("https://www.w3.org/ns/activitystreams#Public"),
        content: "<p>Remote quote</p>",
      }),
    });

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: quotePostIri } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    // The helper rejects the mismatched request before Hollo persists the
    // instrument, so an invalid request leaves no side effects behind.
    expect(quote).toBeUndefined();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  async function seedLocalQuoteTarget(
    quoteApprovalPolicy: "public" | "followers" | "nobody" = "public",
  ) {
    const author = await createAccount({ username: "quote-author" });
    const quotedPostId = crypto.randomUUID() as Uuid;
    const quotedPostIri = `https://hollo.test/@quote-author/${quotedPostId}`;
    await db.insert(posts).values({
      id: quotedPostId,
      iri: quotedPostIri,
      type: "Note",
      accountId: author.id as Uuid,
      visibility: "public",
      quoteApprovalPolicy,
      contentHtml: "<p>Quoted post</p>",
      content: "Quoted post",
      published: new Date(),
    });
    return { authorId: author.id as Uuid, quotedPostId, quotedPostIri };
  }

  const quoterIri = "https://remote.test/@quoter";

  // Modeled on Mastodon 4.5's QuoteRequest and Note serializers, which emit
  // the FEP-044f `quote` together with the `_misskey_quote` and `quoteUri`
  // aliases.  Not captured from live traffic.
  function quoteRequestJson(
    quotedPostIri: string,
    overrides: Record<string, unknown> = {},
    instrumentOverrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const quotePostIri = `${quoterIri}/statuses/1`;
    const json = {
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        {
          QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest",
          quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
          quoteUri: "http://fedibird.com/ns#quoteUri",
          _misskey_quote: "https://misskey-hub.net/ns#_misskey_quote",
        },
      ],
      id: `${quotePostIri}/quote_requests/1`,
      type: "QuoteRequest",
      actor: quoterIri,
      object: quotedPostIri,
      instrument: {
        id: quotePostIri,
        type: "Note",
        attributedTo: {
          id: quoterIri,
          type: "Person",
          preferredUsername: "quoter",
          inbox: `${quoterIri}/inbox`,
        },
        to: "https://www.w3.org/ns/activitystreams#Public",
        content: "<p>Remote quote</p>",
        quote: quotedPostIri,
        quoteUri: quotedPostIri,
        _misskey_quote: quotedPostIri,
        ...instrumentOverrides,
      },
      ...overrides,
    };
    // Drop properties overridden with `undefined`.
    return JSON.parse(JSON.stringify(json));
  }

  function createRequestCtx(loader: DocumentLoader = documentLoader) {
    const sendActivity = vi.fn(async () => undefined);
    const requestCtx = {
      ...ctx,
      documentLoader: loader,
      sendActivity,
    } as unknown as InboxContext<void>;
    return { requestCtx, sendActivity };
  }

  async function seedOrderedQuote() {
    const { quotedPostId, quotedPostIri } = await seedLocalQuoteTarget();
    const { requestCtx, sendActivity } = createRequestCtx();
    const json = quoteRequestJson(quotedPostIri);
    const create = async () =>
      onPostCreated(
        requestCtx,
        new Create({
          actor: new URL(quoterIri),
          object: await Note.fromJsonLd({
            "@context": json["@context"],
            ...(json.instrument as Record<string, unknown>),
          }),
        }),
      );
    const request = async () =>
      onQuoteRequested(requestCtx, await QuoteRequest.fromJsonLd(json));
    return { quotedPostId, quotedPostIri, sendActivity, create, request };
  }

  async function expectAcceptedQuote(
    quotedPostId: Uuid,
    quotedPostIri: string,
  ) {
    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: `${quoterIri}/statuses/1` } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(quote?.quoteAuthorizationIri).toBe(
      `${quotedPostIri}/quote_authorizations/${quote?.id}`,
    );
    expect(
      (
        await db.query.posts.findFirst({
          where: { id: { eq: quotedPostId } },
        })
      )?.quotesCount,
    ).toBe(1);
    return quote!;
  }

  it.each(["create-first", "request-first"])(
    "counts and notifies once with repeated %s delivery",
    async (ordering) => {
      const { quotedPostId, quotedPostIri, sendActivity, create, request } =
        await seedOrderedQuote();
      if (ordering === "create-first") {
        await create();
        await request();
      } else {
        await request();
        await create();
      }
      const quote = await expectAcceptedQuote(quotedPostId, quotedPostIri);
      expect(sendActivity).toHaveBeenCalledOnce();
      const [, , response] = sendActivity.mock.calls[0] as unknown as [
        unknown,
        unknown,
        Accept,
      ];
      expect(response).toBeInstanceOf(Accept);
      expect(response.resultId?.href).toBe(quote.quoteAuthorizationIri);
      await create();
      await request();
      expect(
        await db.query.notifications.findMany({
          where: { type: { eq: "quote" }, targetPostId: { eq: quote.id } },
        }),
      ).toHaveLength(1);
      await expectAcceptedQuote(quotedPostId, quotedPostIri);
    },
  );

  it("counts concurrent Create and QuoteRequest delivery once", async () => {
    const { quotedPostId, quotedPostIri, sendActivity, create, request } =
      await seedOrderedQuote();
    await Promise.all([create(), request()]);
    const quote = await expectAcceptedQuote(quotedPostId, quotedPostIri);
    expect(sendActivity).toHaveBeenCalledOnce();
    const [, , response] = sendActivity.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Accept,
    ];
    expect(response).toBeInstanceOf(Accept);
    expect(response.resultId?.href).toBe(quote.quoteAuthorizationIri);
  });

  it("does not answer a QuoteRequest when revocation lands during persistence", async () => {
    const { quotedPostId, quotedPostIri } = await seedLocalQuoteTarget();
    const json = quoteRequestJson(quotedPostIri);
    const note = await Note.fromJsonLd({
      "@context": json["@context"],
      ...(json.instrument as Record<string, unknown>),
    });
    const quote = await persistPost(db, note, "https://hollo.test", { ...ctx });
    await serveQuoteAuthorization(
      quote!.quoteAuthorizationIri!,
      "https://hollo.test/@quote-author",
      quote!.iri,
      quotedPostIri,
    );
    let revoked = false;
    const loader: DocumentLoader = async (url, options) => {
      if (url === quote!.quoteAuthorizationIri) {
        revoked = true;
        await db.transaction(async (tx) => {
          await tx
            .update(posts)
            .set({ quoteState: "revoked", quoteAuthorizationIri: null })
            .where(eq(posts.id, quote!.id));
          await tx
            .update(posts)
            .set({ quotesCount: 0 })
            .where(eq(posts.id, quotedPostId));
        });
      }
      return documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);
    await onQuoteRequested(
      requestCtx,
      new QuoteRequest({
        id: new URL(`${quote!.iri}#quote-request`),
        actor: new URL(quoterIri),
        object: new URL(quotedPostIri),
        instrument: note.clone({
          quoteAuthorization: new URL(quote!.quoteAuthorizationIri!),
        }),
      }),
    );
    expect(revoked).toBe(true);
    expect(sendActivity).not.toHaveBeenCalled();
    const persisted = await db.query.posts.findFirst({
      where: { id: { eq: quote!.id } },
    });
    expect(persisted?.quoteState).toBe("revoked");
    expect(persisted?.quoteAuthorizationIri).toBeNull();
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: quotedPostId } } }))
        ?.quotesCount,
    ).toBe(0);
  });

  it("rolls back quote acceptance if its notification cannot be saved", async () => {
    const { quotedPostId, quotedPostIri } = await seedLocalQuoteTarget();
    const { requestCtx } = createRequestCtx();
    const json = quoteRequestJson(quotedPostIri);
    async function update() {
      return onPostUpdated(
        requestCtx,
        new Update({
          actor: new URL(quoterIri),
          object: await Note.fromJsonLd({
            "@context": json["@context"],
            ...(json.instrument as Record<string, unknown>),
          }),
        }),
      );
    }
    const notificationModule = await import("../notification");
    const notify = vi
      .spyOn(notificationModule, "createNotification")
      .mockRejectedValueOnce(new Error("Notification storage unavailable"));
    try {
      await expect(update()).rejects.toThrow(
        "Notification storage unavailable",
      );
    } finally {
      notify.mockRestore();
    }
    expect(
      await db.query.posts.findFirst({
        where: { iri: { eq: `${quoterIri}/statuses/1` } },
      }),
    ).toBeUndefined();
    expect(
      (
        await db.query.posts.findFirst({
          where: { id: { eq: quotedPostId } },
        })
      )?.quotesCount,
    ).toBe(0);
    await update();
    const quote = await expectAcceptedQuote(quotedPostId, quotedPostIri);
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote.id } },
      }),
    ).toHaveLength(1);
  });

  it("retains the quote notification when an Update retries a failed attachment fetch", async () => {
    const { quotedPostId, quotedPostIri } = await seedLocalQuoteTarget();
    const attachmentIri = "https://remote.test/attachments/retry";
    let fail = true;
    const loader: DocumentLoader = async (url, options) => {
      if (url !== attachmentIri) return documentLoader(url, options);
      if (fail) {
        fail = false;
        throw Object.assign(new Error("HTTP 503"), {
          response: new Response(null, { status: 503 }),
        });
      }
      return {
        documentUrl: url,
        contextUrl: null,
        document: {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: url,
          type: "Document",
        },
      };
    };
    const { requestCtx } = createRequestCtx(loader);
    const json = quoteRequestJson(quotedPostIri);
    async function update() {
      return onPostUpdated(
        requestCtx,
        new Update({
          actor: new URL(quoterIri),
          object: await Note.fromJsonLd({
            "@context": json["@context"],
            ...(json.instrument as Record<string, unknown>),
            attachment: attachmentIri,
          }),
        }),
      );
    }
    await expect(update()).rejects.toThrow("HTTP 503");
    const quote = await expectAcceptedQuote(quotedPostId, quotedPostIri);
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote.id } },
      }),
    ).toHaveLength(1);
    await update();
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote.id } },
      }),
    ).toHaveLength(1);
  });

  it("notifies and recounts a quote first materialized by Update", async () => {
    const { quotedPostId, quotedPostIri } = await seedLocalQuoteTarget();
    const { requestCtx } = createRequestCtx();
    const json = quoteRequestJson(quotedPostIri);
    async function update(targetIri?: string) {
      const object = await Note.fromJsonLd({
        "@context": json["@context"],
        ...(json.instrument as Record<string, unknown>),
        quote: targetIri,
        quoteUri: targetIri,
        _misskey_quote: targetIri,
      });
      await onPostUpdated(
        requestCtx,
        new Update({
          actor: new URL(quoterIri),
          object,
        }),
      );
    }
    await update(quotedPostIri);
    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: `${quoterIri}/statuses/1` } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: quotedPostId } } }))
        ?.quotesCount,
    ).toBe(1);
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote!.id } },
      }),
    ).toHaveLength(1);
    // Dismissed notifications must not reappear on ordinary edits.
    const notification = await db.query.notifications.findFirst({
      where: { type: { eq: "quote" }, targetPostId: { eq: quote!.id } },
    });
    const { deleteNotifications } = await import("../notification");
    await deleteNotifications(notification!.accountOwnerId, [notification!.id]);
    await update(quotedPostIri);
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote!.id } },
      }),
    ).toHaveLength(0);
    await update();
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: quotedPostId } } }))
        ?.quotesCount,
    ).toBe(0);
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: quote!.id } } }))
        ?.quoteAuthorizationIri,
    ).toBeNull();
  });

  it("accepts a previously unauthorized quote on Update and recounts when retargeted", async () => {
    const { quotedPostId, quotedPostIri, authorId } =
      await seedLocalQuoteTarget("nobody");
    const { requestCtx } = createRequestCtx();
    async function update(iri: string) {
      const json = quoteRequestJson(iri);
      await onPostUpdated(
        requestCtx,
        new Update({
          actor: new URL(quoterIri),
          object: await Note.fromJsonLd({
            "@context": json["@context"],
            ...(json.instrument as Record<string, unknown>),
          }),
        }),
      );
    }
    await update(quotedPostIri);
    expect(
      (
        await db.query.posts.findFirst({
          where: { iri: { eq: `${quoterIri}/statuses/1` } },
        })
      )?.quoteState,
    ).toBe("unauthorized");
    await db
      .update(posts)
      .set({ quoteApprovalPolicy: "public" })
      .where(eq(posts.id, quotedPostId));
    await update(quotedPostIri);
    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: `${quoterIri}/statuses/1` } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote!.id } },
      }),
    ).toHaveLength(1);
    const nextId = crypto.randomUUID() as Uuid;
    const nextIri = `https://hollo.test/@quote-author/${nextId}`;
    await db.insert(posts).values({
      id: nextId,
      iri: nextIri,
      accountId: authorId,
      type: "Note",
      visibility: "public",
      quoteApprovalPolicy: "public",
      published: new Date(),
    });
    await update(nextIri);
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: quotedPostId } } }))
        ?.quotesCount,
    ).toBe(0);
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: nextId } } }))
        ?.quotesCount,
    ).toBe(1);
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: quote!.id } } }))
        ?.quoteAuthorizationIri,
    ).toBe(`${nextIri}/quote_authorizations/${quote!.id}`);
    // Same-owner retargets use the existing notification deduplication key.
    expect(
      await db.query.notifications.findMany({
        where: { type: { eq: "quote" }, targetPostId: { eq: quote!.id } },
      }),
    ).toHaveLength(1);
  });

  it("accepts a Mastodon-shaped QuoteRequest with a helper-built Accept", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const { requestCtx, sendActivity } = createRequestCtx();
    const json = quoteRequestJson(quotedPostIri);
    const request = await QuoteRequest.fromJsonLd(json);

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: `${quoterIri}/statuses/1` } },
    });
    expect(quote?.quoteState).toBe("accepted");
    expect(sendActivity).toHaveBeenCalledOnce();
    const [, , response] = sendActivity.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Accept,
    ];
    expect(response).toBeInstanceOf(Accept);
    expect(response.id?.href).toMatch(/^https:\/\/hollo\.test\/#Accept\//);
    expect(response.toIds.map((id) => id.href)).toEqual([quoterIri]);
    const authorization = await response.getResult();
    expect(authorization).toBeInstanceOf(QuoteAuthorization);
    expect((authorization as QuoteAuthorization).id?.href).toBe(
      quote?.quoteAuthorizationIri,
    );
    expect(
      (authorization as QuoteAuthorization).interactingObjectId?.href,
    ).toBe(quote?.iri);
    expect(
      (authorization as QuoteAuthorization).interactionTargetId?.href,
    ).toBe(quotedPostIri);
    // The echoed request keeps the sender's representation.
    const echoed = (await response.toJsonLd()) as {
      object: { id: string; instrument: { content: string } };
    };
    expect(echoed.object.id).toBe(json.id);
    expect(echoed.object.instrument.content).toBe("<p>Remote quote</p>");
  });

  it.each([
    ["without an id", { id: undefined }, {}],
    ["without an actor", { actor: undefined }, {}],
    [
      "whose quote and quoteUrl disagree",
      {},
      {
        quoteUri: "https://hollo.test/@quote-author/other",
        _misskey_quote: "https://hollo.test/@quote-author/other",
      },
    ],
  ])("ignores a QuoteRequest %s", async (_, overrides, instrumentOverrides) => {
    const { quotedPostId, quotedPostIri } = await seedLocalQuoteTarget();
    const { requestCtx, sendActivity } = createRequestCtx();
    const request = await QuoteRequest.fromJsonLd(
      quoteRequestJson(quotedPostIri, overrides, instrumentOverrides),
    );

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: `${quoterIri}/statuses/1` } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: quotedPostId } },
    });
    expect(quote).toBeUndefined();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("refetches a cross-origin embedded instrument", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const instrumentIri = "https://other.test/notes/1";
    remoteDocuments.set(instrumentIri, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: instrumentIri,
      type: "Note",
      attributedTo: "https://other.test/@victim",
      content: "<p>The real note</p>",
    });
    const loader = vi.fn(documentLoader);
    const { requestCtx, sendActivity } = createRequestCtx(loader);
    const request = await QuoteRequest.fromJsonLd(
      // The embedded copy claims the requester wrote it.
      quoteRequestJson(quotedPostIri, {}, { id: instrumentIri }),
    );

    await onQuoteRequested(requestCtx, request);

    expect(loader.mock.calls.map(([url]) => url)).toContain(instrumentIri);
    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: instrumentIri } },
    });
    expect(quote).toBeUndefined();
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("echoes the sender's request after refetching a cross-origin instrument", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const instrumentIri = `${quoterIri}/statuses/1`;
    // The request comes from another origin than its embedded instrument.
    const json = quoteRequestJson(
      quotedPostIri,
      { id: "https://relay.test/quote-requests/1" },
      { content: "<p>Embedded copy</p>" },
    );
    const instrument = json.instrument as Record<string, unknown>;
    remoteDocuments.set(instrumentIri, {
      ...instrument,
      "@context": json["@context"],
      content: "<p>Fetched copy</p>",
    });
    const { requestCtx, sendActivity } = createRequestCtx();
    const request = await QuoteRequest.fromJsonLd(json);

    await onQuoteRequested(requestCtx, request);

    const quote = await db.query.posts.findFirst({
      where: { iri: { eq: instrumentIri } },
    });
    expect(quote?.contentHtml).toBe("<p>Fetched copy</p>");
    expect(quote?.quoteState).toBe("accepted");
    expect(sendActivity).toHaveBeenCalledOnce();
    const [, , response] = sendActivity.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Accept,
    ];
    const echoed = (await response.toJsonLd()) as {
      object: { instrument: { content: string } };
    };
    expect(echoed.object.instrument.content).toBe("<p>Embedded copy</p>");
  });

  it("retries a QuoteRequest whose instrument fetch fails transiently", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const instrumentIri = `${quoterIri}/statuses/1`;
    const loader: DocumentLoader = async (url, options) => {
      if (url === instrumentIri) throw new TypeError("fetch failed");
      return await documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);
    const request = await QuoteRequest.fromJsonLd(
      quoteRequestJson(quotedPostIri, { instrument: instrumentIri }),
    );

    await expect(onQuoteRequested(requestCtx, request)).rejects.toThrow(
      "fetch failed",
    );
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("does not retry a QuoteRequest whose instrument URL is refused", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const instrumentIri = `${quoterIri}/statuses/1`;
    const loader: DocumentLoader = async (url, options) => {
      if (url === instrumentIri) {
        // Fedify's SSRF protection rejects private addresses this way.
        throw Object.assign(new Error("Invalid or private address"), {
          name: "UrlError",
        });
      }
      return await documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);
    const request = await QuoteRequest.fromJsonLd(
      quoteRequestJson(quotedPostIri, { instrument: instrumentIri }),
    );

    await expect(onQuoteRequested(requestCtx, request)).resolves.toBe(
      undefined,
    );
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("retries a QuoteRequest whose instrument host fails DNS lookup", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const instrumentIri = `${quoterIri}/statuses/1`;
    const loader: DocumentLoader = async (url, options) => {
      if (url === instrumentIri) {
        throw Object.assign(new Error("DNS lookup failed"), {
          name: "UrlError",
          reason: "dns",
        });
      }
      return await documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);
    const request = await QuoteRequest.fromJsonLd(
      quoteRequestJson(quotedPostIri, { instrument: instrumentIri }),
    );

    await expect(onQuoteRequested(requestCtx, request)).rejects.toThrow(
      "DNS lookup failed",
    );
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("ignores a QuoteRequest whose instrument is gone", async () => {
    const { quotedPostIri } = await seedLocalQuoteTarget();
    const { requestCtx, sendActivity } = createRequestCtx();
    const request = await QuoteRequest.fromJsonLd(
      quoteRequestJson(quotedPostIri, {
        instrument: `${quoterIri}/statuses/1`,
      }),
    );

    await onQuoteRequested(requestCtx, request);

    expect(sendActivity).not.toHaveBeenCalled();
  });

  it.each([
    ["followers", true, Accept],
    ["followers", false, Reject],
    ["nobody", true, Reject],
  ] as const)(
    "evaluates the %s policy (approved follower: %s)",
    async (policy, approvedFollower, responseClass) => {
      const { authorId, quotedPostIri } = await seedLocalQuoteTarget(policy);
      const quoterId = await seedRemoteAccount("quoter");
      if (approvedFollower) {
        await db.insert(follows).values({
          iri: `${quoterIri}#follows/1`,
          followerId: quoterId,
          followingId: authorId,
          approved: new Date(),
        });
      }
      const { requestCtx, sendActivity } = createRequestCtx();
      const request = await QuoteRequest.fromJsonLd(
        quoteRequestJson(quotedPostIri),
      );

      await onQuoteRequested(requestCtx, request);

      const quote = await db.query.posts.findFirst({
        where: { iri: { eq: `${quoterIri}/statuses/1` } },
      });
      expect(quote?.quoteState).toBe(
        responseClass === Accept ? "accepted" : "rejected",
      );
      expect(sendActivity).toHaveBeenCalledOnce();
      const [, , response] = sendActivity.mock.calls[0] as unknown as [
        unknown,
        unknown,
        Accept | Reject,
      ];
      expect(response).toBeInstanceOf(responseClass);
      expect(response.id?.href).toMatch(
        new RegExp(`^https://hollo\\.test/#${responseClass.name}/`),
      );
    },
  );

  function getAuthorizationIri(seeded: {
    quotedPostIri: string;
    quotePostId: string;
  }): string {
    return `${seeded.quotedPostIri}/quote_authorizations/${seeded.quotePostId}`;
  }

  function createAccept(
    seeded: { quotePostIri: string; quotedPostIri: string },
    result: URL | QuoteAuthorization,
  ): Accept {
    return new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new URL(`${seeded.quotePostIri}#quote-request`),
      result,
    });
  }

  async function expectStillPending(seeded: {
    quotePostId: Uuid;
    quotedPostId: Uuid;
  }): Promise<void> {
    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("pending");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
  }

  it.each<
    [
      string,
      {
        attribution?: string;
        interactingObject?: string;
        interactionTarget?: string;
      },
    ]
  >([
    [
      "a wrong attribution",
      { attribution: "https://hollo.test/@quote-quoter" },
    ],
    ["a wrong quote", { interactingObject: "https://hollo.test/@x/1" }],
    ["a wrong target", { interactionTarget: "https://hollo.test/@x/2" }],
  ])(
    "does not accept a quote whose authorization has %s",
    async (_, override) => {
      const seeded = await seedPendingQuote();
      const authorizationIri = getAuthorizationIri(seeded);
      await serveQuoteAuthorization(
        authorizationIri,
        override.attribution ?? "https://hollo.test/@quote-author",
        override.interactingObject ?? seeded.quotePostIri,
        override.interactionTarget ?? seeded.quotedPostIri,
      );
      const { requestCtx, sendActivity } = createRequestCtx();

      const accepted = await onQuoteRequestAccepted(
        requestCtx,
        createAccept(seeded, new URL(authorizationIri)),
      );

      expect(accepted).toBe(false);
      expect(sendActivity).not.toHaveBeenCalled();
      await expectStillPending(seeded);
    },
  );

  it("does not accept an authorization hosted on another origin", async () => {
    const seeded = await seedPendingQuote();
    const authorizationIri = "https://remote.test/quote_authorizations/1";
    await serveQuoteAuthorization(
      authorizationIri,
      "https://hollo.test/@quote-author",
      seeded.quotePostIri,
      seeded.quotedPostIri,
    );
    const loader = vi.fn(documentLoader);
    const { requestCtx } = createRequestCtx(loader);

    const accepted = await onQuoteRequestAccepted(
      requestCtx,
      createAccept(seeded, new URL(authorizationIri)),
    );

    expect(accepted).toBe(false);
    expect(loader).not.toHaveBeenCalled();
    await expectStillPending(seeded);
  });

  it("does not accept an authorization that is gone or of the wrong type", async () => {
    const seeded = await seedPendingQuote();
    const { requestCtx } = createRequestCtx();
    const goneIri = `${seeded.quotedPostIri}/quote_authorizations/gone`;
    const noteIri = `${seeded.quotedPostIri}/quote_authorizations/note`;
    remoteDocuments.set(noteIri, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: noteIri,
      type: "Note",
      attributedTo: "https://hollo.test/@quote-author",
    });

    for (const iri of [goneIri, noteIri]) {
      expect(
        await onQuoteRequestAccepted(
          requestCtx,
          createAccept(seeded, new URL(iri)),
        ),
      ).toBe(false);
    }
    await expectStillPending(seeded);
  });

  it("does not trust an embedded authorization contradicted by its source", async () => {
    const seeded = await seedPendingQuote();
    const authorizationIri = getAuthorizationIri(seeded);
    await serveQuoteAuthorization(
      authorizationIri,
      "https://hollo.test/@quote-author",
      "https://hollo.test/@quote-quoter/another-quote",
      seeded.quotedPostIri,
    );
    const { requestCtx } = createRequestCtx();

    const accepted = await onQuoteRequestAccepted(
      requestCtx,
      createAccept(
        seeded,
        new QuoteAuthorization({
          id: new URL(authorizationIri),
          attribution: new URL("https://hollo.test/@quote-author"),
          interactingObject: new URL(seeded.quotePostIri),
          interactionTarget: new URL(seeded.quotedPostIri),
        }),
      ),
    );

    expect(accepted).toBe(false);
    await expectStillPending(seeded);
  });

  it("retries an Accept whose authorization fetch fails transiently", async () => {
    const seeded = await seedPendingQuote();
    let failures = 1;
    const loader: DocumentLoader = async (url, options) => {
      if (url === getAuthorizationIri(seeded) && failures-- > 0) {
        throw new TypeError("fetch failed");
      }
      return await documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);
    const accept = createAccept(seeded, new URL(getAuthorizationIri(seeded)));

    await expect(onQuoteRequestAccepted(requestCtx, accept)).rejects.toThrow(
      "Failed to dereference the quote authorization",
    );
    await expectStillPending(seeded);
    expect(await onQuoteRequestAccepted(requestCtx, accept)).toBe(true);

    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quoted?.quotesCount).toBe(1);
    expect(sendActivity).toHaveBeenCalledOnce();
  });

  it("retries an Accept whose authorization host fails DNS lookup", async () => {
    const seeded = await seedPendingQuote();
    const loader: DocumentLoader = async (url, options) => {
      if (url === getAuthorizationIri(seeded)) {
        throw Object.assign(new Error("DNS lookup failed"), {
          name: "UrlError",
          reason: "dns",
        });
      }
      return await documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);

    await expect(
      onQuoteRequestAccepted(
        requestCtx,
        createAccept(seeded, new URL(getAuthorizationIri(seeded))),
      ),
    ).rejects.toThrow("Failed to dereference the quote authorization");
    expect(sendActivity).not.toHaveBeenCalled();
    await expectStillPending(seeded);
  });

  it("retries an Accept whose JSON-LD context fails to load transiently", async () => {
    const seeded = await seedPendingQuote();
    const contextUrl = "https://flaky-context.example/ns";
    const authorizationIri = getAuthorizationIri(seeded);
    const document = remoteDocuments.get(authorizationIri) as {
      "@context": unknown[];
    };
    remoteDocuments.set(authorizationIri, {
      ...document,
      "@context": [...document["@context"], contextUrl],
    });
    let failures = 1;
    const loader: DocumentLoader = async (url, options) => {
      if (url === contextUrl) {
        if (failures-- > 0) throw new TypeError("fetch failed");
        return {
          contextUrl: null,
          document: { "@context": {} },
          documentUrl: url,
        };
      }
      return await documentLoader(url, options);
    };
    const { requestCtx } = createRequestCtx(loader);
    const accept = createAccept(seeded, new URL(authorizationIri));

    await expect(onQuoteRequestAccepted(requestCtx, accept)).rejects.toThrow(
      "Failed to dereference the quote authorization",
    );
    expect(await onQuoteRequestAccepted(requestCtx, accept)).toBe(true);

    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quoted?.quotesCount).toBe(1);
  });

  it("counts concurrent Accepts for the same quote once", async () => {
    const seeded = await seedPendingQuote();
    const { requestCtx, sendActivity } = createRequestCtx();
    const accept = createAccept(seeded, new URL(getAuthorizationIri(seeded)));

    const results = await Promise.all([
      onQuoteRequestAccepted(requestCtx, accept),
      onQuoteRequestAccepted(requestCtx, accept),
    ]);

    expect(results.filter((accepted) => accepted)).toHaveLength(1);
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quoted?.quotesCount).toBe(1);
    expect(sendActivity).toHaveBeenCalledOnce();
  });

  it("keeps a rejection that lands while an Accept is being verified", async () => {
    const seeded = await seedPendingQuote();
    const authorizationIri = getAuthorizationIri(seeded);
    const { requestCtx: rejectCtx } = createRequestCtx();
    const loader: DocumentLoader = async (url, options) => {
      if (url === authorizationIri) {
        await onQuoteRequestRejected(
          rejectCtx,
          new Reject({
            actor: new URL("https://hollo.test/@quote-author"),
            object: new URL(`${seeded.quotePostIri}#quote-request`),
          }),
        );
      }
      return await documentLoader(url, options);
    };
    const { requestCtx, sendActivity } = createRequestCtx(loader);

    const accepted = await onQuoteRequestAccepted(
      requestCtx,
      createAccept(seeded, new URL(authorizationIri)),
    );

    expect(accepted).toBe(false);
    expect(sendActivity).not.toHaveBeenCalled();
    const quote = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotePostId } },
    });
    const quoted = await db.query.posts.findFirst({
      where: { id: { eq: seeded.quotedPostId } },
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
  });
});
