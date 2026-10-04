import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";
import { createExpiredPollPost } from "../../../tests/helpers/poll";
import db from "../../db";
import { federation, pollNotifications } from "../../federation/federation";
import app from "../../index";
import { accountOwners, polls } from "../../schema";
import type { Uuid } from "../../uuid";

beforeEach(cleanDatabase);
afterEach(() => vi.restoreAllMocks());

describe("Poll vote task scheduling", () => {
  it.each([false, true])(
    "schedules a committed vote (remote author: %s), retaining it if enqueue fails",
    async (remote) => {
      const author = await createAccount({ generateKeyPair: true });
      const p = await createExpiredPollPost(
        author.id as Uuid,
        new Date(Date.now() + 60_000),
      );
      if (remote)
        await db
          .delete(accountOwners)
          .where(eq(accountOwners.id, author.id as Uuid));
      const voter = await createAccount({
        username: "voter",
        generateKeyPair: true,
      });
      const client = await createOAuthApplication({
        scopes: ["write:statuses"],
      });
      const token = await getAccessToken(client, voter, ["write:statuses"]);
      vi.spyOn(federation, "createContext").mockReturnValue({
        url: new URL("https://hollo.test"),
        sendActivity: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReturnType<typeof federation.createContext>);
      const enqueue = vi
        .spyOn(pollNotifications, "enqueue")
        .mockImplementation(async (_ctx, pollId) => {
          const committed = await db.query.pollVotes.findMany({
            where: { pollId: { eq: pollId } },
          });
          expect(committed.map((vote) => vote.accountId)).toEqual([voter.id]);
          throw new Error("queue offline");
        });
      const response = await app.request(`/api/v1/polls/${p.pollId}/votes`, {
        method: "POST",
        headers: {
          authorization: bearerAuthorization(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ choices: [0] }),
      });
      expect(response.status).toBe(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][1]).toBe(p.pollId);
      expect((await response.json()).voted).toBe(true);
      expect(
        (await db.query.polls.findFirst({ where: { id: { eq: p.pollId } } }))
          ?.votersCount,
      ).toBe(1);
      await db
        .update(polls)
        .set({ expires: new Date(Date.now() - 1) })
        .where(eq(polls.id, p.pollId));
      const rejected = await app.request(`/api/v1/polls/${p.pollId}/votes`, {
        method: "POST",
        headers: {
          authorization: bearerAuthorization(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ choices: [1] }),
      });
      expect(rejected.status).toBe(422);
      expect(enqueue).toHaveBeenCalledTimes(1);
    },
  );
});
