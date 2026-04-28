import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  Delete,
  Note,
  Person,
  QuoteAuthorization,
  QuoteRequest,
  Reject,
  Update,
} from "@fedify/vocab";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import {
  accounts,
  blocks,
  follows,
  instances,
  notifications,
  posts,
} from "../schema";
import type { Uuid } from "../uuid";
import {
  onFollowAccepted,
  onFollowRejected,
  onQuoteAuthorizationDeleted,
  onQuoteRequested,
  onQuoteRequestAccepted,
  onQuoteRequestRejected,
} from "./inbox";

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
    where: eq(accounts.id, followerOwner.id as Uuid),
  });
  const following = await db.query.accounts.findFirst({
    where: eq(accounts.id, followingOwner.id as Uuid),
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

const ctx = {
  origin: "https://hollo.test",
  recipient: "follower",
} as InboxContext<void>;

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
      where: and(
        eq(follows.followerId, seeded.followerId),
        eq(follows.followingId, seeded.followingId),
      ),
    });
    expect(follow).toBeDefined();
    expect(follow?.approved).not.toBeNull();
  });

  it("updates the follower's followingCount when approved via embedded Follow object (Path B)", async () => {
    expect.assertions(2);

    const seeded = await seedFollow();

    const followerBefore = await db.query.accounts.findFirst({
      where: eq(accounts.id, seeded.followerId),
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
      where: eq(accounts.id, seeded.followerId),
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
      where: and(
        eq(follows.followerId, seeded.followerId),
        eq(follows.followingId, seeded.followingId),
      ),
    });
    expect(follow).toBeUndefined();
  });
});

describe("quote request lifecycle", () => {
  beforeEach(async () => {
    await cleanDatabase();
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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
    });
    expect(accepted).toBe(false);
    expect(quote?.quoteState).toBe("pending");
    expect(quote?.quoteAuthorizationIri).toBeNull();
    expect(quoted?.quotesCount).toBe(0);
  });

  it("federates the quote update after Accept<QuoteRequest>", async () => {
    expect.assertions(7);

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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
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

    await onQuoteRequestRejected(ctx, reject);

    const quote = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
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

    await onQuoteRequestRejected(ctx, reject);

    const quote = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
    });
    expect(quote?.quoteState).toBe("rejected");
    expect(quoted?.quotesCount).toBe(0);
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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
    });
    expect(quote?.quoteState).toBe("revoked");
    expect(quoted?.quotesCount).toBe(0);
  });

  it("federates the quote update after authorization deletion", async () => {
    expect.assertions(7);

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
      where: eq(posts.id, seeded.quotePostId),
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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
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
      where: eq(posts.id, seeded.quotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, seeded.quotedPostId),
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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
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
      where: eq(posts.id, localQuotePostId),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
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
      where: eq(posts.iri, quotePostIri),
      with: { account: true },
    });
    if (quote == null) throw new Error("Failed to persist quote");
    const notification = await db.query.notifications.findFirst({
      where: and(
        eq(notifications.type, "quote"),
        eq(notifications.accountOwnerId, author.id as Uuid),
        eq(notifications.actorAccountId, quote.accountId),
        eq(notifications.targetPostId, quote.id),
      ),
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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
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
      where: eq(posts.iri, quotePostIri),
    });
    const oldPost = await db.query.posts.findFirst({
      where: eq(posts.id, oldPostId),
    });
    const newPost = await db.query.posts.findFirst({
      where: eq(posts.id, newPostId),
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
      where: eq(posts.iri, quotePostIri),
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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
    });
    expect(quote).toBeUndefined();
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("ignores a QuoteRequest whose quote targets another object", async () => {
    expect.assertions(4);

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
      where: eq(posts.iri, quotePostIri),
    });
    const quoted = await db.query.posts.findFirst({
      where: eq(posts.id, quotedPostId),
    });
    expect(quote?.quoteTargetIri).toBe(otherPostIri);
    expect(quote?.quoteState).toBe("unauthorized");
    expect(quoted?.quotesCount).toBe(0);
    expect(sendActivity).not.toHaveBeenCalled();
  });
});
