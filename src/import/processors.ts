import type { Context } from "@fedify/fedify";
import { type DocumentLoader, isActor } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { TerminalJobItemError } from "../background/errors";
import db from "../db";
import {
  blockAccount,
  followAccount,
  persistAccount,
} from "../federation/account";
import { isPost, persistPost } from "../federation/post";
import * as schema from "../schema";
import type { Uuid } from "../uuid";
import { prepareImportEffect } from "./delivery";

const logger = getLogger(["hollo", "import-processors"]);

function validate<T>(validator: z.ZodType<T>, data: unknown): T {
  const result = validator.safeParse(data);
  if (!result.success) throw new TerminalJobItemError(result.error.message);
  return result.data;
}

export async function processFollowItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
  check: () => Promise<void>,
): Promise<void> {
  const data = validate(
    z.object({
      handle: z.string(),
      shares: z.boolean(),
      notify: z.boolean(),
      languages: z.array(z.string()).optional(),
    }),
    item.data,
  );

  const actor = await fedCtx.lookupObject(data.handle, { documentLoader });
  if (!isActor(actor)) {
    throw new Error(`Could not find actor: ${data.handle}`);
  }

  const target = await persistAccount(
    db,
    actor,
    new URL(accountOwner.account.iri).origin,
    { documentLoader },
  );
  if (!target) {
    throw new Error(`Could not persist account: ${data.handle}`);
  }

  await prepareImportEffect(
    item.id,
    fedCtx,
    async (tx, capture) => {
      const follow = await followAccount(
        tx,
        capture,
        { ...accountOwner.account, owner: accountOwner },
        target,
        {
          iri: new URL(`#import-follow/${item.id}`, accountOwner.account.iri),
          shares: data.shares,
          notify: data.notify,
          languages: data.languages,
        },
      );
      if (follow) return { kind: "follow", iri: follow.iri };
    },
    check,
  );

  logger.debug("Followed account {handle}", { handle: data.handle });
}

export async function processMuteItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
  check: () => Promise<void>,
): Promise<void> {
  const data = validate(
    z.object({ handle: z.string(), notifications: z.boolean() }),
    item.data,
  );

  const actor = await fedCtx.lookupObject(data.handle, { documentLoader });
  if (!isActor(actor)) {
    throw new Error(`Could not find actor: ${data.handle}`);
  }

  const target = await persistAccount(
    db,
    actor,
    new URL(accountOwner.account.iri).origin,
    { documentLoader },
  );
  if (!target) {
    throw new Error(`Could not persist account: ${data.handle}`);
  }

  await prepareImportEffect(
    item.id,
    fedCtx,
    async (tx) => {
      await tx
        .insert(schema.mutes)
        .values({
          id: crypto.randomUUID() as Uuid,
          accountId: accountOwner.id,
          mutedAccountId: target.id,
          notifications: data.notifications,
        })
        .onConflictDoNothing();
    },
    check,
  );

  logger.debug("Muted account {handle}", { handle: data.handle });
}

export async function processBlockItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
  check: () => Promise<void>,
): Promise<void> {
  const data = validate(z.object({ handle: z.string() }), item.data);

  const actor = await fedCtx.lookupObject(data.handle, { documentLoader });
  if (!isActor(actor)) {
    throw new Error(`Could not find actor: ${data.handle}`);
  }

  const target = await persistAccount(
    db,
    actor,
    new URL(accountOwner.account.iri).origin,
    { documentLoader },
  );
  if (!target) {
    throw new Error(`Could not persist account: ${data.handle}`);
  }

  await prepareImportEffect(
    item.id,
    fedCtx,
    async (tx, capture) => {
      const block = await blockAccount(tx, capture, accountOwner, target);
      if (block) return { kind: "block", ...block };
    },
    check,
  );

  logger.debug("Blocked account {handle}", { handle: data.handle });
}

export async function processBookmarkItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
  check: () => Promise<void>,
): Promise<void> {
  const data = validate(z.object({ iri: z.url() }), item.data);

  const obj = await fedCtx.lookupObject(data.iri, { documentLoader });

  if (!isPost(obj)) {
    throw new Error(`Object is not a post: ${data.iri}`);
  }

  const post = await persistPost(
    db,
    obj,
    new URL(accountOwner.account.iri).origin,
    { documentLoader },
  );
  if (!post) {
    throw new Error(`Could not persist post: ${data.iri}`);
  }

  await prepareImportEffect(
    item.id,
    fedCtx,
    async (tx) => {
      await tx
        .insert(schema.bookmarks)
        .values({
          postId: post.id,
          accountOwnerId: accountOwner.id,
        })
        .onConflictDoNothing();
    },
    check,
  );

  logger.debug("Bookmarked post {iri}", { iri: data.iri });
}

export async function processListItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
  check: () => Promise<void>,
): Promise<void> {
  const data = validate(
    z.object({ listName: z.string(), handle: z.string() }),
    item.data,
  );

  // First, lookup the actor
  const actor = await fedCtx.lookupObject(data.handle, { documentLoader });
  if (!isActor(actor)) {
    throw new Error(`Could not find actor: ${data.handle}`);
  }

  const account = await persistAccount(
    db,
    actor,
    new URL(accountOwner.account.iri).origin,
    { documentLoader },
  );
  if (!account) {
    throw new Error(`Could not persist account: ${data.handle}`);
  }

  await prepareImportEffect(
    item.id,
    fedCtx,
    async (tx, capture) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${accountOwner.id}), hashtext(${data.listName}))`,
      );
      // Find or create the list
      let list = await tx.query.lists.findFirst({
        where: {
          RAW: (lists, { and, eq }) =>
            and(
              eq(lists.accountOwnerId, accountOwner.id),
              eq(lists.title, data.listName),
            )!,
        },
      });

      if (!list) {
        const result = await tx
          .insert(schema.lists)
          .values({
            id: crypto.randomUUID() as Uuid,
            title: data.listName,
            accountOwnerId: accountOwner.id,
          })
          .onConflictDoNothing()
          .returning();

        if (result.length < 1) {
          // List was created concurrently, try to find it again
          list = await tx.query.lists.findFirst({
            where: {
              RAW: (lists, { and, eq }) =>
                and(
                  eq(lists.accountOwnerId, accountOwner.id),
                  eq(lists.title, data.listName),
                )!,
            },
          });
        } else {
          list = result[0];
        }
      }

      if (!list) {
        throw new Error(`Could not create or find list: ${data.listName}`);
      }

      const follow = await followAccount(
        tx,
        capture,
        { ...accountOwner.account, owner: accountOwner },
        account,
        {
          iri: new URL(`#import-follow/${item.id}`, accountOwner.account.iri),
        },
      );

      // Add to list
      await tx
        .insert(schema.listMembers)
        .values({
          listId: list.id,
          accountId: account.id,
        })
        .onConflictDoNothing();
      if (follow) return { kind: "follow", iri: follow.iri };
    },
    check,
  );

  logger.debug("Added {handle} to list {listName}", {
    handle: data.handle,
    listName: data.listName,
  });
}
