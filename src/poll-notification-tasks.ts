import {
  createExponentialBackoffPolicy,
  type Context,
  type Federation,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";

import db, { type DatabaseLike } from "./db";
import {
  findMissingPollNotifications,
  notifyExpiredPoll,
} from "./notification";
import type { Poll } from "./schema";
import { uuid, type Uuid } from "./uuid";

const logger = getLogger(["hollo", "poll-notifications"]);
// Remote endTime and local expires_in are unbounded. Keep each wakeup below
// Node's signed 32-bit timer limit; an early handler replaces its message.
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export function registerPollNotifications(
  federation: Federation<void>,
  readyDepth: () => Promise<number>,
  options: {
    clock?: () => Date;
    signal?: AbortSignal;
    batchSize?: number;
  } = {},
) {
  const clock = options.clock ?? (() => new Date());
  let signal = options.signal;
  let cursor: Pick<Poll, "id" | "expires"> | undefined;
  const batchSize = options.batchSize ?? 100;

  const task = federation.defineTask("hollo.poll-notification.v1", {
    schema: z.object({ pollId: uuid }),
    // Fedify passes a zero-based attempt: initial delivery plus two retries.
    retryPolicy: createExponentialBackoffPolicy({ maxAttempts: 2 }),
    onError: (_ctx, error, { pollId }) => {
      logger.error("Poll {pollId} notification task failed: {error}", {
        pollId,
        error,
      });
    },
    handler: async (ctx, { pollId }) => {
      if (signal?.aborted) return;
      const expires = await notifyExpiredPoll(pollId, clock());
      if (expires != null && !signal?.aborted) {
        // No TTL marker: consuming an early/old message must always replace
        // itself, even when an earlier enqueue is still inside its TTL.
        await schedule(ctx, pollId, expires);
      }
    },
  });

  async function schedule(ctx: Context<void>, pollId: Uuid, expires: Date) {
    await ctx.enqueueTask(
      task,
      { pollId },
      {
        orderingKey: `hollo.poll-notification:${pollId}`,
        delay: {
          milliseconds: Math.min(
            MAX_DELAY_MS,
            Math.max(0, +expires - +clock()),
          ),
        },
      },
    );
  }

  async function enqueue(ctx: Context<void>, pollId: Uuid) {
    if (signal?.aborted) return;
    try {
      const poll = await db.query.polls.findFirst({
        where: { id: { eq: pollId } },
        with: {
          posts: { with: { account: { with: { owner: true } } } },
          votes: { with: { account: { with: { owner: true } } } },
        },
      });
      if (
        poll == null ||
        !(
          poll.posts.some((post) => post.account.owner != null) ||
          poll.votes.some((vote) => vote.account.owner != null)
        )
      )
        return;
      if (!signal?.aborted) await schedule(ctx, pollId, poll.expires);
    } catch (error) {
      logger.error(
        "Poll {pollId} dispatch failed; recovery will retry: {error}",
        {
          pollId,
          error,
        },
      );
    }
  }

  async function recover(ctx: Context<void>) {
    if (signal?.aborted) return;
    try {
      if ((await readyDepth()) >= 200) return;
      const candidates = await findMissingPollNotifications({
        now: clock(),
        limit: batchSize,
        after: cursor,
      });
      for (const poll of candidates) {
        if (signal?.aborted) return;
        // Advance even when enqueue fails or delivery hasn't completed, so
        // the oldest page cannot strand later polls. A later wrap retries it.
        cursor = poll;
        await enqueue(ctx, poll.id);
      }
      if (candidates.length < batchSize) cursor = undefined;
    } catch (error) {
      // Recovery callbacks share a loop: failures here must not skip import,
      // cleanup or remote replies recovery in this pass.
      logger.error("Poll notification recovery failed: {error}", { error });
    }
  }

  return {
    task,
    enqueue,
    recover,
    setSignal(value: AbortSignal) {
      signal = value;
    },
  };
}

/** Only dispatch committed rows; transaction callers use durable recovery. */
export async function enqueuePollNotification(
  database: DatabaseLike,
  pollId: Uuid,
  baseUrl: URL | string,
): Promise<void> {
  if (database !== db) return;
  try {
    const { federation, pollNotifications } =
      await import("./federation/federation");
    await pollNotifications.enqueue(
      federation.createContext(new URL(baseUrl), undefined),
      pollId,
    );
  } catch (error) {
    logger.error("Poll {pollId} committed but dispatch failed: {error}", {
      pollId,
      error,
    });
  }
}
