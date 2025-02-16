import {
  type Activity,
  type Context,
  type DocumentLoader,
  Follow,
  type Recipient,
  type SenderKeyPair,
  Undo,
} from "@fedify/fedify";
import {
  type ExtractTablesWithRelations,
  and,
  eq,
  isNotNull,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import * as schema from "../schema";

// Use fixed username and id for the relay client actor
// Why use fixed username and id?
// Because the relay client actor is a special actor that is not supposed to be interacted with by users.
// Also, if we delete the a relay and send the Undo activity, the relay client needs to be online.
// For example, AodeRelay first fetches the actor from our server again, and if we already deleted the actor, it will fail
// and the realy keeps our server in the database.
// And because we won't receive an activity to check whether the Undo was successful, we can't delete the relay client actor safely.
export const HOLLO_RELAY_ACTOR_ID = "8a683714-6fa2-4e53-9f05-b4acbcda4db7";
export const HOLLO_RELAY_ACTOR_USERNAME = "~hollo~relay~follower~";

/**
 * Workaround fedify jsonld serialization for relay follow.
 *
 * Without this, the jsonld serialization would be:
 * ```json
 * {
 *  "@context": "https://www.w3.org/ns/activitystreams",
 *  "id": "https://client.example/6ae15297",
 *  "type": "Follow",
 *  "actor": "https://client.example/actor",
 *  "object": "as:public"
 * }
 * ```
 * instead of
 * ```json
 * {
 *  "@context": "https://www.w3.org/ns/activitystreams",
 *  "id": "https://client.example/6ae15297",
 *  "type": "Follow",
 *  "actor": "https://client.example/actor",
 *  "object": "https://www.w3.org/ns/activitystreams#Public"
 * }
 * ```
 */
export class RelayFollow extends Follow {
  async toJsonLd(options?: {
    format?: "compact" | "expand";
    contextLoader?: DocumentLoader;
    context?:
      | string
      | Record<string, string>
      | (string | Record<string, string>)[];
  }): Promise<unknown> {
    const json = (await super.toJsonLd(options)) as { object: string };
    json.object = "https://www.w3.org/ns/activitystreams#Public";
    return json;
  }
}

/**
 * Similar workaround as RelayFollow. However, normaly we should not need to do this, because the spec is very clear that we are allowed to set object to just the id.
 *
 * But AodeRelay does not support this, so we need to work around this and send the full Follow object.
 */
export class RelayUndo extends Undo {
  async toJsonLd(options?: {
    format?: "compact" | "expand";
    contextLoader?: DocumentLoader;
    context?:
      | string
      | Record<string, string>
      | (string | Record<string, string>)[];
  }): Promise<unknown> {
    await this.getObject();
    const json = (await super.toJsonLd(options)) as { object: unknown };
    json.object = await (await this.getObject())?.toJsonLd();
    return json;
  }
}

export async function getRelayRecipients(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
): Promise<Recipient[]> {
  const acceptedRelays = await db.query.relays.findMany({
    where: and(
      eq(schema.relays.state, "accepted"),
      isNotNull(schema.relays.relayServerActorId),
    ),
    with: {
      relayServerActor: true,
    },
  });
  return acceptedRelays.map((relay) => ({
    id: new URL(relay.relayServerActor!.iri),
    inboxId: new URL(relay.relayServerActor!.inboxUrl),
  }));
}

/**
 * Forward a given activity to all relays currently active
 * @param db Database instance or transaction
 * @param ctx fedify context
 * @param sender Sender of the activity
 * @param activity Activity to forward to relays
 */
export async function forwardActivityToRelays(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  ctx: Context<unknown>,
  sender:
    | SenderKeyPair
    | SenderKeyPair[]
    | {
        identifier: string;
      }
    | {
        username: string;
      }
    | {
        handle: string;
      },
  activity: Activity,
) {
  const recipients = await getRelayRecipients(db);
  await ctx.sendActivity(sender, recipients, activity);
}
