import { Accept, Follow, Reject } from "@fedify/vocab";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import db from "../../db";
import {
  serializeAccount,
  serializeAccountOwner,
  serializeRelationship,
} from "../../entities/account";
import { federation } from "../../federation";
import { updateAccountStats } from "../../federation/account";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { accounts, blocks, follows, mutes } from "../../schema";
import { isUuid } from "../../uuid";

const app = new Hono<{ Variables: Variables }>();

app.get("/", tokenRequired, scopeRequired(["read:follows"]), async (c) => {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const followers = await db.query.follows.findMany({
    where: and(eq(follows.followingId, owner.id), isNull(follows.approved)),
    with: { follower: { with: { owner: true, successor: true } } },
  });
  return c.json(
    followers.map((f) =>
      f.follower.owner == null
        ? serializeAccount(f.follower, c.req.url)
        : serializeAccountOwner(
            { ...f.follower.owner, account: f.follower },
            c.req.url,
          ),
    ),
  );
});

app.post(
  "/:account_id/authorize",
  tokenRequired,
  scopeRequired(["write:follows"]),
  async (c) => {
    const followerId = c.req.param("account_id");
    if (!isUuid(followerId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const follower = await db.query.accounts.findFirst({
      where: eq(accounts.id, followerId),
      with: { owner: true },
    });
    if (follower == null) return c.json({ error: "Record not found" }, 404);
    const result = await db
      .update(follows)
      .set({ approved: new Date() })
      .where(
        and(
          eq(follows.followingId, owner.id),
          eq(follows.followerId, followerId),
          isNull(follows.approved),
        ),
      )
      .returning({ iri: follows.iri });
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    if (follower.owner == null) {
      const fedCtx = federation.createContext(c.req.raw, undefined);
      await fedCtx.sendActivity(
        { username: owner.handle },
        { id: new URL(follower.iri), inboxId: new URL(follower.inboxUrl) },
        new Accept({
          id: new URL(`#accepts/${follower.iri}`, owner.account.iri),
          actor: new URL(owner.account.iri),
          object: new Follow({
            id: new URL(result[0].iri),
            actor: new URL(follower.iri),
            object: new URL(owner.account.iri),
          }),
        }),
        { excludeBaseUris: [new URL(c.req.url)] },
      );
    }
    await updateAccountStats(db, { id: owner.id });
    const follower2 = await db.query.accounts.findFirst({
      where: eq(accounts.id, followerId),
      with: {
        followers: {
          where: eq(follows.followerId, owner.id),
        },
        following: {
          where: eq(follows.followingId, owner.id),
        },
        mutedBy: {
          where: eq(mutes.accountId, owner.id),
        },
        blocks: {
          where: eq(blocks.blockedAccountId, owner.id),
        },
        blockedBy: {
          where: eq(blocks.accountId, owner.id),
        },
      },
    });
    if (follower2 == null) return c.json({ error: "Record not found" }, 404);
    return c.json(serializeRelationship(follower2, owner));
  },
);

app.post(
  "/:account_id/reject",
  tokenRequired,
  scopeRequired(["write:follows"]),
  async (c) => {
    const followerId = c.req.param("account_id");
    if (!isUuid(followerId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const follower = await db.query.accounts.findFirst({
      where: eq(accounts.id, followerId),
      with: { owner: true },
    });
    if (follower == null) return c.json({ error: "Record not found" }, 404);
    const result = await db
      .delete(follows)
      .where(
        and(
          eq(follows.followingId, owner.id),
          eq(follows.followerId, followerId),
          isNull(follows.approved),
        ),
      )
      .returning({ iri: follows.iri });
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    if (follower.owner == null) {
      const fedCtx = federation.createContext(c.req.raw, undefined);
      await fedCtx.sendActivity(
        { username: owner.handle },
        { id: new URL(follower.iri), inboxId: new URL(follower.inboxUrl) },
        new Reject({
          id: new URL(`#rejects/${follower.iri}`, owner.account.iri),
          actor: new URL(owner.account.iri),
          object: new Follow({
            id: new URL(result[0].iri),
            actor: new URL(follower.iri),
            object: new URL(owner.account.iri),
          }),
        }),
        { excludeBaseUris: [new URL(c.req.url)] },
      );
    }
    const follower2 = await db.query.accounts.findFirst({
      where: eq(accounts.id, followerId),
      with: {
        followers: {
          where: eq(follows.followerId, owner.id),
        },
        following: {
          where: eq(follows.followingId, owner.id),
        },
        mutedBy: {
          where: eq(mutes.accountId, owner.id),
        },
        blocks: {
          where: eq(blocks.blockedAccountId, owner.id),
        },
        blockedBy: {
          where: eq(blocks.accountId, owner.id),
        },
      },
    });
    if (follower2 == null) return c.json({ error: "Record not found" }, 404);
    return c.json(serializeRelationship(follower2, owner));
  },
);

export default app;
