import {
  type Context,
  type DocumentLoader,
  type Object as FedifyObject,
  isActor,
  type Link,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq } from "drizzle-orm";
import db from "../db";
import {
  blockAccount,
  followAccount,
  persistAccount,
} from "../federation/account";
import { isPost, persistPost } from "../federation/post";
import * as schema from "../schema";
import type { Uuid } from "../uuid";

const logger = getLogger(["hollo", "import-processors"]);

// Type for follow item data
interface FollowItemData {
  handle: string;
  shares: boolean;
  notify: boolean;
  languages?: string[];
}

// Type for mute item data
interface MuteItemData {
  handle: string;
  notifications: boolean;
}

// Type for block item data
interface BlockItemData {
  handle: string;
}

// Type for bookmark item data
interface BookmarkItemData {
  iri: string;
}

// Type for list item data
interface ListItemData {
  listName: string;
  handle: string;
}

export async function processFollowItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
): Promise<void> {
  const data = item.data as unknown as FollowItemData;

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

  await followAccount(
    db,
    fedCtx,
    { ...accountOwner.account, owner: accountOwner },
    target,
    {
      shares: data.shares,
      notify: data.notify,
      languages: data.languages,
    },
  );

  logger.debug("Followed account {handle}", { handle: data.handle });
}

export async function processMuteItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
): Promise<void> {
  const data = item.data as unknown as MuteItemData;

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

  await db
    .insert(schema.mutes)
    .values({
      id: crypto.randomUUID() as Uuid,
      accountId: accountOwner.id,
      mutedAccountId: target.id,
      notifications: data.notifications,
    })
    .onConflictDoNothing();

  logger.debug("Muted account {handle}", { handle: data.handle });
}

export async function processBlockItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
): Promise<void> {
  const data = item.data as unknown as BlockItemData;

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

  await blockAccount(db, fedCtx, accountOwner, target);

  logger.debug("Blocked account {handle}", { handle: data.handle });
}

export async function processBookmarkItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
): Promise<void> {
  const data = item.data as unknown as BookmarkItemData;

  let obj: FedifyObject | Link | null;
  try {
    obj = await fedCtx.lookupObject(data.iri, { documentLoader });
  } catch (error) {
    logger.error("Failed to lookup object {iri}: {error}", {
      iri: data.iri,
      error,
    });
    throw new Error(`Could not lookup object: ${data.iri}`);
  }

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

  await db
    .insert(schema.bookmarks)
    .values({
      postId: post.id,
      accountOwnerId: accountOwner.id,
    })
    .onConflictDoNothing();

  logger.debug("Bookmarked post {iri}", { iri: data.iri });
}

export async function processListItem(
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
  fedCtx: Context<void>,
  documentLoader: DocumentLoader,
): Promise<void> {
  const data = item.data as unknown as ListItemData;

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

  // Find or create the list
  let list = await db.query.lists.findFirst({
    where: and(
      eq(schema.lists.accountOwnerId, accountOwner.id),
      eq(schema.lists.title, data.listName),
    ),
  });

  if (!list) {
    const result = await db
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
      list = await db.query.lists.findFirst({
        where: and(
          eq(schema.lists.accountOwnerId, accountOwner.id),
          eq(schema.lists.title, data.listName),
        ),
      });
    } else {
      list = result[0];
    }
  }

  if (!list) {
    throw new Error(`Could not create or find list: ${data.listName}`);
  }

  // Follow the account (lists require follows)
  try {
    await followAccount(
      db,
      fedCtx,
      { ...accountOwner.account, owner: accountOwner },
      account,
    );
  } catch (error) {
    // Ignore if already following
    logger.debug("Follow may already exist for {handle}: {error}", {
      handle: data.handle,
      error,
    });
  }

  // Add to list
  await db
    .insert(schema.listMembers)
    .values({
      listId: list.id,
      accountId: account.id,
    })
    .onConflictDoNothing();

  logger.debug("Added {handle} to list {listName}", {
    handle: data.handle,
    listName: data.listName,
  });
}
