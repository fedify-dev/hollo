import { eq } from "drizzle-orm";

import { TerminalJobItemError } from "../background/errors";
import type { Lease } from "../background/lease";
import db from "../db";
import federation from "../federation/federation";
import * as schema from "../schema";
import { deliverImportEffect } from "./delivery";
import {
  processBlockItem,
  processBookmarkItem,
  processFollowItem,
  processListItem,
  processMuteItem,
} from "./processors";

export async function executeImportItem(
  job: schema.ImportJob,
  item: schema.ImportJobItem,
  check: () => Promise<void>,
  lease: Lease,
  checkDelivery: () => Promise<void>,
) {
  const owner = await db.query.accountOwners.findFirst({
    where: { id: { eq: job.accountOwnerId } },
    with: { account: true },
  });
  if (!owner) throw new TerminalJobItemError("Account owner not found");
  const ctx = federation.createContext(
    new URL(new URL(owner.account.iri).origin),
    undefined,
  );
  const [effect] = await db
    .select()
    .from(schema.importJobEffects)
    .where(eq(schema.importJobEffects.itemId, item.id));
  if (!effect) {
    await check();
    const loader = await ctx.getDocumentLoader({ username: owner.handle });
    const processor = {
      following_accounts: processFollowItem,
      muted_accounts: processMuteItem,
      blocked_accounts: processBlockItem,
      bookmarks: processBookmarkItem,
      lists: processListItem,
    }[job.category];
    await processor(item, owner, ctx, loader, check);
  }
  await deliverImportEffect(item.id, ctx, checkDelivery, lease);
}
