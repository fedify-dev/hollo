import * as vocab from "@fedify/fedify/vocab";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { serializeReport } from "../../entities/report";
import federation from "../../federation";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import {
  accountOwners,
  accounts,
  type Post,
  posts,
  type Report,
  reports,
} from "../../schema";
import { uuid, uuidv7 } from "../../uuid";

const app = new Hono<{ Variables: Variables }>();

const reportSchema = z.object({
  comment: z.string().trim().min(1).max(1000).optional().default(""),
  account_id: uuid,
  status_ids: z.array(uuid).min(1).optional(),
  // discarded by defined by the Mastodon API:
  category: z.string().optional(),
  rule_ids: z.array(z.string()).optional(),
  forward: z.boolean().optional(),
  forward_to_domains: z.array(z.string()).optional(),
});

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:reports"]),
  zValidator("json", reportSchema),
  async (c) => {
    const accountOwner = c.get("token").accountOwner;
    if (accountOwner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const data = c.req.valid("json");

    // Assert that we're not reporting ourselves:
    if (accountOwner.account.id === data.account_id) {
      return c.json({ error: "You cannot report yourself" }, 400);
    }

    // Check we actually have the account we want to report:
    const targetAccount = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.id, data.account_id),
        notInArray(
          accounts.id,
          db.select({ id: accountOwners.id }).from(accountOwners),
        ),
      ),
      with: { owner: true, successor: true },
    });

    if (targetAccount == null) {
      return c.json({ error: "Record not found" }, 404);
    }

    // Fetch the posts we want to report, and ensure they are all by the target
    // account, if we don't find all posts with the given status_ids, then we
    // fail the request:
    let targetPosts: Post[] = [];
    if (data.status_ids != null && data.status_ids.length > 0) {
      targetPosts = await db.query.posts.findMany({
        where: and(
          inArray(posts.id, data.status_ids),
          eq(posts.accountId, targetAccount.id),
        ),
      });

      if (targetPosts.length !== data.status_ids.length) {
        return c.json({ error: "Record not found" }, 404);
      }
    }

    const fedCtx = federation.createContext(c.req.raw, undefined);

    let report: Report;
    try {
      const id = uuidv7();
      const iri = fedCtx.getObjectUri(vocab.Flag, { id }).href;

      const result = await db
        .insert(reports)
        .values({
          id,
          iri,
          accountId: accountOwner.id,
          targetAccountId: targetAccount.id,
          comment: data.comment,
          posts: targetPosts.map((post) => post.id),
        })
        .returning();
      report = result[0];
    } catch (_) {
      return c.json({ error: "Record not found" }, 404);
    }

    // Finally send the Flag activity to the targetAccount's server:
    await fedCtx.sendActivity(
      { username: accountOwner.handle },
      {
        id: new URL(targetAccount.iri),
        inboxId: new URL(targetAccount.inboxUrl),
      },
      new vocab.Flag({
        id: new URL(report.iri),
        actor: new URL(accountOwner.account.iri),
        // For Mastodon compatibility, objects must include the target account IRI along with the posts:
        objects: targetPosts
          .map((post) => new URL(post.iri))
          .concat(new URL(targetAccount.iri)),
        content: report.comment,
      }),
      {
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );

    return c.json(serializeReport(report, targetAccount, c.req.url));
  },
);

export default app;
