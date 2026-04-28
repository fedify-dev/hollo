import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  Delete,
  Note,
  Person,
  QuoteAuthorization,
  QuoteRequest,
  Reject,
} from "@fedify/vocab";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows, posts } from "../schema";
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
    const accept = new Accept({
      actor: new URL("https://hollo.test/@quote-author"),
      object: new QuoteRequest({
        object: new URL(seeded.quotedPostIri),
        instrument: new URL(seeded.quotePostIri),
      }),
      result: new URL(authorizationIri),
    });

    await onQuoteRequestAccepted(ctx, accept);

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

  it("marks an accepted quote revoked when its authorization is deleted", async () => {
    expect.assertions(2);

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
});
