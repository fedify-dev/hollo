import { type Context } from "@fedify/fedify";
import { Follow, Note, Person } from "@fedify/vocab";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import { itemLeases } from "../background/lease";
import db from "../db";
import * as accountModule from "../federation/account";
import federation from "../federation/federation";
import * as postModule from "../federation/post";
import * as schema from "../schema";
import { uuidv7 } from "../uuid";
import { deliverImportEffect, prepareImportEffect } from "./delivery";
import {
  processBlockItem,
  processBookmarkItem,
  processFollowItem,
  processListItem,
  processMuteItem,
} from "./processors";

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await itemLeases.close();
});
const check = async () => {};
async function fixture(
  category: schema.ImportJobCategory,
  data: Record<string, unknown>,
  remote = false,
) {
  const local = await createAccount();
  const target = await createAccount({ username: "target" });
  const owner = (await db.query.accountOwners.findFirst({
    where: { id: { eq: local.id } },
    with: { account: true },
  }))!;
  const account = (await db.query.accounts.findFirst({
    where: { id: { eq: target.id } },
    with: { owner: true },
  }))!;
  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );
  const actor = new Person({
    id: new URL(account.iri),
    preferredUsername: "target",
    inbox: new URL(account.inboxUrl),
  });
  vi.spyOn(ctx, "lookupObject").mockResolvedValue(actor);
  vi.spyOn(accountModule, "persistAccount").mockResolvedValue({
    ...account,
    owner: remote ? null : account.owner,
  });
  const jobId = uuidv7();
  await db
    .insert(schema.importJobs)
    .values({ id: jobId, accountOwnerId: owner.id, category, totalItems: 1 });
  const item = (
    await db
      .insert(schema.importJobItems)
      .values({ id: uuidv7(), jobId, data })
      .returning()
  )[0];
  return { owner, account, ctx, item };
}

it("prepares Follow before sending and replays a failed enqueue with the saved ID", async () => {
  const f = await fixture(
    "following_accounts",
    {
      handle: "@target@remote.test",
      shares: false,
      notify: true,
      languages: ["ko"],
    },
    true,
  );
  const send = vi
    .spyOn(f.ctx, "sendActivity")
    .mockRejectedValueOnce(new Error("queue offline"))
    .mockImplementation(async (_sender, _recipients, activity) => {
      const [follow] = await db.select().from(schema.follows);
      expect(follow.iri).toBe(activity.id!.href);
    });
  await processFollowItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  expect(send).not.toHaveBeenCalled();
  expect((await db.select().from(schema.follows))[0]).toMatchObject({
    shares: false,
    notify: true,
    languages: ["ko"],
  });
  await expect(deliverImportEffect(f.item.id, f.ctx, check)).rejects.toThrow(
    "queue offline",
  );
  await deliverImportEffect(f.item.id, f.ctx, check);
  await deliverImportEffect(f.item.id, f.ctx, check);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][2].id?.href).toBe(send.mock.calls[1][2].id?.href);
  expect(send.mock.calls[1][2]).toBeInstanceOf(Follow);
  expect((await db.select().from(schema.importJobEffects))[0].delivered).toBe(
    1,
  );
});

it("imports mutes without replaying DB effects", async () => {
  const f = await fixture("muted_accounts", {
    handle: "target",
    notifications: true,
  });
  await processMuteItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  await processMuteItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  expect(await db.select().from(schema.mutes)).toHaveLength(1);
  expect((await db.select().from(schema.mutes))[0].notifications).toBe(true);
});

it("imports blocks idempotently and retains the ID used by unblock", async () => {
  const f = await fixture("blocked_accounts", { handle: "target" }, true);
  await processBlockItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  await processBlockItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  const send = vi.spyOn(f.ctx, "sendActivity").mockResolvedValue(undefined);
  await deliverImportEffect(f.item.id, f.ctx, check);
  expect(await db.select().from(schema.blocks)).toHaveLength(1);
  expect(send.mock.calls.at(-1)![2].id!.href).toBe(
    `${f.owner.account.iri}#block/${f.account.id}`,
  );
});

it("imports bookmarks", async () => {
  const f = await fixture("bookmarks", { iri: "https://hollo.test/post" });
  const post = (
    await db
      .insert(schema.posts)
      .values({
        id: uuidv7(),
        iri: "https://hollo.test/post",
        accountId: f.account.id,
        type: "Note",
        visibility: "public",
      })
      .returning()
  )[0];
  vi.mocked(f.ctx.lookupObject).mockResolvedValue(
    new Note({ id: new URL(post.iri) }),
  );
  vi.spyOn(postModule, "persistPost").mockResolvedValue({
    ...post,
    account: { ...f.account },
    mentions: [],
  });
  await processBookmarkItem(
    f.item,
    f.owner,
    f.ctx,
    f.ctx.documentLoader,
    check,
  );
  await processBookmarkItem(
    f.item,
    f.owner,
    f.ctx,
    f.ctx.documentLoader,
    check,
  );
  expect(await db.select().from(schema.bookmarks)).toHaveLength(1);
});

it("serializes concurrent list creation and adds each member once", async () => {
  const f = await fixture("lists", { listName: "Friends", handle: "target" });
  const other = (
    await db
      .insert(schema.importJobItems)
      .values({ id: uuidv7(), jobId: f.item.jobId, data: f.item.data })
      .returning()
  )[0];
  await Promise.all(
    [f.item, other].map((item) =>
      processListItem(item, f.owner, f.ctx, f.ctx.documentLoader, check),
    ),
  );
  expect(await db.select().from(schema.lists)).toHaveLength(1);
  expect(await db.select().from(schema.listMembers)).toHaveLength(1);
  expect(await db.select().from(schema.follows)).toHaveLength(1);
});

it("rolls back local effects with the delivery marker when preparation fails", async () => {
  const f = await fixture("muted_accounts", {
    handle: "target",
    notifications: true,
  });
  await expect(
    prepareImportEffect(
      f.item.id,
      f.ctx,
      async (tx) => {
        await tx.insert(schema.mutes).values({
          id: uuidv7(),
          accountId: f.owner.id,
          mutedAccountId: f.account.id,
        });
        throw new Error("crash before preparation commit");
      },
      check,
    ),
  ).rejects.toThrow("crash before preparation commit");
  expect(await db.select().from(schema.mutes)).toHaveLength(0);
  expect(await db.select().from(schema.importJobEffects)).toHaveLength(0);
});

it("does not overwrite a committed marker after ownership loss", async () => {
  const f = await fixture(
    "following_accounts",
    { handle: "target", shares: true, notify: false },
    true,
  );
  await processFollowItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  const mutate = vi.fn(async () => {});
  await prepareImportEffect(f.item.id, f.ctx as Context<void>, mutate, check);
  expect(mutate).not.toHaveBeenCalled();
  expect(
    (
      await db
        .select()
        .from(schema.importJobEffects)
        .where(eq(schema.importJobEffects.itemId, f.item.id))
    )[0].deliveries,
  ).toHaveLength(1);
});

it.each(["following_accounts", "blocked_accounts"] as const)(
  "skips superseded %s delivery after the user removes the relationship",
  async (category) => {
    const f = await fixture(
      category,
      { handle: "target", shares: true, notify: false },
      true,
    );
    const process =
      category === "following_accounts" ? processFollowItem : processBlockItem;
    await process(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
    const send = vi
      .spyOn(f.ctx, "sendActivity")
      .mockRejectedValueOnce(new Error("queue offline"));
    await expect(deliverImportEffect(f.item.id, f.ctx, check)).rejects.toThrow(
      "queue offline",
    );
    if (category === "following_accounts") {
      await db.delete(schema.follows);
      // A newer follow of the same actor must not revive the older request.
      await db.insert(schema.follows).values({
        iri: "https://hollo.test/new-follow",
        followerId: f.owner.id,
        followingId: f.account.id,
      });
    } else {
      await db.delete(schema.blocks);
      // Re-blocking creates a different intent, even though Block uses a stable ID.
      await db.insert(schema.blocks).values({
        accountId: f.owner.id,
        blockedAccountId: f.account.id,
        created: "2099-01-01T00:00:00Z",
      });
    }
    await deliverImportEffect(f.item.id, f.ctx, check);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.importJobEffects))[0].delivered).toBe(
      1,
    );
  },
);

it("holds the relationship row until import enqueue finishes so unfollow follows it", async () => {
  const f = await fixture(
    "following_accounts",
    { handle: "target", shares: true, notify: false },
    true,
  );
  await processFollowItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  let release!: () => void;
  const send = vi.spyOn(f.ctx, "sendActivity").mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const delivery = deliverImportEffect(f.item.id, f.ctx, check);
  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledOnce();
  });
  let deleted = false;
  const deletion = db.delete(schema.follows).then(() => {
    deleted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(deleted).toBe(false);
  release();
  await delivery;
  await deletion;
  expect(deleted).toBe(true);
});

it("waits for the actual send after delivery transaction connection loss and leaves the intent unacked", async () => {
  const f = await fixture(
    "following_accounts",
    { handle: "target", shares: true, notify: false },
    true,
  );
  await processFollowItem(f.item, f.owner, f.ctx, f.ctx.documentLoader, check);
  let release!: () => void;
  let entered!: (pid: number) => void;
  const started = new Promise<number>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(f.ctx, "sendActivity").mockImplementation(async () => {
    const [row] = await db.execute<{ pid: number }>(sql`SELECT pid FROM pg_locks
      WHERE relation = 'follows'::regclass AND mode = 'RowShareLock'
        AND granted AND pid <> pg_backend_pid()`);
    entered(row.pid);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  let settled = false;
  const delivery = deliverImportEffect(f.item.id, f.ctx, check).catch(
    (error) => {
      settled = true;
      return error;
    },
  );
  const pid = await started;
  await db.execute(sql`SELECT pg_terminate_backend(${pid})`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(settled).toBe(false);
  release();
  const error = await delivery;
  expect(error).toBeInstanceOf(Error);
  expect((await db.select().from(schema.importJobEffects))[0].delivered).toBe(
    0,
  );
});
