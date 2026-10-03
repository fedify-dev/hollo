import type { Context } from "@fedify/fedify";
import { Activity, type Recipient } from "@fedify/vocab";
import { and, eq, sql } from "drizzle-orm";

import { itemLeases, type Lease } from "../background/lease";
import db, { type Transaction } from "../db";
import { blocks, follows, importJobEffects } from "../schema";
import type { Uuid } from "../uuid";

export type ImportRelationship =
  | { kind: "follow"; iri: string }
  | { kind: "block"; accountId: Uuid; blockedAccountId: Uuid; created: string };

export interface ImportDelivery {
  relationship?: ImportRelationship;
  sender: string;
  recipients: Array<{
    id: string | null;
    inboxId: string | null;
    sharedInboxId: string | null;
  }>;
  activity: unknown;
  orderingKey?: string;
  excludeBaseUris: string[];
  preferSharedInbox?: boolean;
}

// The marker is both the mutex and the durable handoff. A lease-lost attempt
// cannot replace another attempt's prepared deliveries with an empty array.
export async function prepareImportEffect(
  itemId: Uuid,
  ctx: Context<void>,
  mutate: (
    tx: Transaction,
    capture: Context<void>,
  ) => Promise<ImportRelationship | void>,
  check: () => Promise<void>,
) {
  await check();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const inserted = await tx
      .insert(importJobEffects)
      .values({ itemId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return;
    const deliveries: ImportDelivery[] = [];
    const capture = new Proxy(ctx, {
      get(target, property) {
        if (property === "sendActivity")
          return async (
            sender: { username: string },
            recipients: Recipient | Recipient[],
            activity: Activity,
            options: {
              orderingKey?: string;
              excludeBaseUris?: URL[];
              preferSharedInbox?: boolean;
            } = {},
          ) => {
            deliveries.push({
              sender: sender.username,
              recipients: (Array.isArray(recipients)
                ? recipients
                : [recipients]
              ).map((recipient) => ({
                id: recipient.id?.href ?? null,
                inboxId: recipient.inboxId?.href ?? null,
                sharedInboxId: recipient.endpoints?.sharedInbox?.href ?? null,
              })),
              activity: await activity.toJsonLd({ format: "expand" }),
              orderingKey: options.orderingKey,
              excludeBaseUris:
                options.excludeBaseUris?.map((uri) => uri.href) ?? [],
              preferSharedInbox: options.preferSharedInbox,
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await check();
    const relationship = await mutate(tx, capture);
    if (relationship)
      for (const delivery of deliveries) delivery.relationship = relationship;
    await check();
    await tx
      .update(importJobEffects)
      .set({ deliveries })
      .where(eq(importJobEffects.itemId, itemId));
  });
}

export async function deliverImportEffect(
  itemId: Uuid,
  ctx: Context<void>,
  check: () => Promise<void>,
  lease?: Lease,
): Promise<void> {
  if (!lease) {
    return itemLeases.run((owned) =>
      deliverImportEffect(itemId, ctx, check, owned),
    );
  }
  const [effect] = await db
    .select()
    .from(importJobEffects)
    .where(eq(importJobEffects.itemId, itemId));
  if (!effect) throw new Error("Import effect was not prepared");
  for (
    let index = effect.delivered;
    index < effect.deliveries.length;
    index++
  ) {
    await check();
    const delivery = effect.deliveries[index];
    const activity = await Activity.fromJsonLd(delivery.activity);
    await check();
    {
      const tx = lease.db;
      // DELETE in unfollow/unblock waits for this row lock. The import enqueue
      // therefore precedes its Undo, or is skipped if the user removed/replaced
      // the relationship before retry. Guard all Block-related side activities.
      let current = true;
      const relationship = delivery.relationship;
      if (relationship?.kind === "follow") {
        const rows = await tx
          .select({ iri: follows.iri })
          .from(follows)
          .where(eq(follows.iri, relationship.iri))
          .for("share");
        current = rows.length > 0;
      } else if (relationship?.kind === "block") {
        const rows = await tx
          .select({ created: blocks.created })
          .from(blocks)
          .where(
            and(
              eq(blocks.accountId, relationship.accountId),
              eq(blocks.blockedAccountId, relationship.blockedAccountId),
              eq(blocks.created, relationship.created),
            ),
          )
          .for("share");
        current = rows.length > 0;
      }
      await check();
      lease.assertOwned();
      if (current)
        await ctx.sendActivity(
          { username: delivery.sender },
          delivery.recipients.map((recipient) => ({
            id: recipient.id ? new URL(recipient.id) : null,
            inboxId: recipient.inboxId ? new URL(recipient.inboxId) : null,
            endpoints: {
              sharedInbox: recipient.sharedInboxId
                ? new URL(recipient.sharedInboxId)
                : null,
            },
          })),
          activity,
          {
            orderingKey: delivery.orderingKey,
            excludeBaseUris: delivery.excludeBaseUris.map(
              (uri) => new URL(uri),
            ),
            preferSharedInbox: delivery.preferSharedInbox,
          },
        );
      await check();
      lease.assertOwned();
      await tx
        .update(importJobEffects)
        .set({
          delivered: sql`greatest(${importJobEffects.delivered}, ${index + 1})`,
        })
        .where(eq(importJobEffects.itemId, itemId));
    }
  }
}
