import { Create, Note } from "@fedify/fedify";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { maxBy } from "es-toolkit";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { serializePoll } from "../../entities/poll";
import { federation } from "../../federation";
import { toUpdate } from "../../federation/post";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { pollOptions, polls, pollVotes } from "../../schema";
import { isUuid } from "../../uuid";

const app = new Hono<{ Variables: Variables }>();

app.get("/:id", tokenRequired, scopeRequired(["read:statuses"]), async (c) => {
  const pollId = c.req.param("id");
  if (!isUuid(pollId)) return c.json({ error: "Record not found" }, 404);
  const owner = c.get("token").accountOwner;
  if (owner == null) return c.json({ error: "Unauthorized" }, 401);
  const poll = await db.query.polls.findFirst({
    with: {
      options: { orderBy: pollOptions.index },
      votes: { where: eq(pollVotes.accountId, owner.id) },
    },
    where: eq(polls.id, pollId),
  });
  if (poll == null) return c.json({ error: "Record not found" }, 404);
  return c.json(serializePoll(poll, owner));
});

app.post(
  "/:id/votes",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  zValidator(
    "json",
    z.object({
      choices: z.array(
        z.union([
          z.number().int(),
          z
            .string()
            .regex(/^\d+$/)
            .transform((s) => Number.parseInt(s, 10)),
        ]),
      ),
    }),
  ),
  async (c) => {
    const pollId = c.req.param("id");
    if (!isUuid(pollId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid" }, 401);
    }
    const choices = c.req.valid("json").choices;
    let poll = await db.query.polls.findFirst({
      with: {
        options: true,
        votes: {
          with: { account: true },
          where: eq(pollVotes.accountId, owner.id),
        },
        posts: {
          with: {
            account: { with: { owner: true } },
            replyTarget: true,
            quoteTarget: true,
            media: true,
            mentions: { with: { account: true } },
            replies: true,
          },
        },
      },
      where: eq(polls.id, pollId),
    });
    if (poll == null) return c.json({ error: "Record not found" }, 404);
    if (poll.expires <= new Date()) {
      return c.json(
        { error: "Validation failed: The poll has already ended" },
        422,
      );
    }
    if (poll.votes.length > 0) {
      return c.json(
        { error: "Validation failed: You have already voted on this poll" },
        422,
      );
    }
    if (!poll.multiple && choices.length > 1) {
      return c.json(
        { error: "Validation failed: This poll does not allow multiple votes" },
        422,
      );
    }
    if (choices.length < 1) {
      return c.json(
        { error: "Validation failed: You must select at least one option" },
        422,
      );
    }
    await db.transaction(async (tx) => {
      await tx.insert(pollVotes).values(
        choices.map((choice) => ({
          accountId: owner.id,
          pollId: poll!.id,
          optionIndex: choice,
        })),
      );
      await tx
        .update(pollOptions)
        .set({
          votesCount: sql`${pollOptions.votesCount} + 1`,
        })
        .where(
          and(
            eq(pollOptions.pollId, poll!.id),
            inArray(pollOptions.index, choices),
          ),
        );
      await tx
        .update(polls)
        .set({
          votersCount: sql`${polls.votersCount} + 1`,
        })
        .where(eq(polls.id, poll!.id));
    });
    poll = await db.query.polls.findFirst({
      with: {
        options: true,
        votes: {
          with: { account: true },
          where: eq(pollVotes.accountId, owner.id),
        },
        posts: {
          with: {
            account: { with: { owner: true } },
            replyTarget: true,
            quoteTarget: true,
            media: true,
            mentions: { with: { account: true } },
            replies: true,
          },
        },
      },
      where: eq(polls.id, pollId),
    });
    if (poll == null) throw new Error("Record not found");
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const posts = poll.posts.filter((p) => p.sharingId == null);
    const post = maxBy(posts, (p) => +(p.published ?? p.updated))!;
    if (post.account.owner == null) {
      for (const choice of choices) {
        await fedCtx.sendActivity(
          owner,
          [
            {
              id: new URL(post.account.iri),
              inboxId: new URL(post.account.inboxUrl),
            },
          ],
          new Create({
            id: new URL(
              `#votes/${poll.id}/${choice}/activity`,
              owner.account.iri,
            ),
            actor: new URL(owner.account.iri),
            to: new URL(post.account.iri),
            object: new Note({
              id: new URL(`#votes/${poll.id}/${choice}`, owner.account.iri),
              name: poll.options[choice].title,
              attribution: new URL(owner.account.iri),
              replyTarget: new URL(post.iri),
              to: new URL(post.account.iri),
            }),
          }),
          {
            excludeBaseUris: [new URL(c.req.url)],
          },
        );
      }
    } else {
      await fedCtx.sendActivity(
        post.account.owner,
        poll.votes.map((v) => ({
          id: new URL(v.account.iri),
          inboxId: new URL(v.account.inboxUrl),
          endpoints:
            v.account.sharedInboxUrl == null
              ? null
              : {
                  sharedInbox: new URL(v.account.sharedInboxUrl),
                },
        })),
        toUpdate({ ...post, poll }, fedCtx),
        { excludeBaseUris: [new URL(c.req.url)] },
      );
    }
    return c.json(serializePoll(poll, owner));
  },
);

export default app;
