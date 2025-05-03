import { exportJwk, generateCryptoKeyPair, isActor } from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";
import { count, eq, sql } from "drizzle-orm";
import { interval, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import {
  HOLLO_RELAY_ACTOR_ID,
  HOLLO_RELAY_ACTOR_USERNAME,
  RelayFollow,
  RelayUndo,
} from "../entities/relay";
import federation from "../federation";
import { persistAccount } from "../federation/account";
import { isPost, persistPost } from "../federation/post";
import { loginRequired } from "../login";
import { accountOwners, accounts, instances, relays } from "../schema";

const data = new Hono();

data.use(loginRequired);

data.get("/", async (c) => {
  const done = c.req.query("done");
  const error = c.req.query("error");

  let queueMessages: { type: string; number: number }[];
  try {
    queueMessages = await db
      .select({
        type: sql<string>`fedify_message_v2.message ->> 'type'`,
        number: count(),
      })
      .from(sql`fedify_message_v2`)
      .groupBy(sql`fedify_message_v2.message ->> 'type'`)
      .execute();
  } catch {
    queueMessages = [];
  }

  const relays = await db.query.relays.findMany({
    with: {
      relayServerActor: true,
    },
  });

  return c.html(
    <DashboardLayout title="Hollo: Federation" selectedMenu="federation">
      <hgroup>
        <h1>Federation</h1>
        <p>
          This control panel allows you to manage remote objects or interactions
          with the fediverse.
        </p>
      </hgroup>

      <article>
        <header>
          <hgroup>
            <h2>Force refresh account/post</h2>
            {done === "refresh:account" ? (
              <p>Account has been refreshed.</p>
            ) : done === "refresh:post" ? (
              <p>Post has been refreshed.</p>
            ) : (
              <p>Use this when you see outdated remote account/post data.</p>
            )}
          </hgroup>
        </header>
        <form
          method="post"
          action="/federation/refresh"
          onsubmit="this.submit.ariaBusy = 'true'"
        >
          <fieldset role="group">
            <input
              type="text"
              name="uri"
              placeholder="@hollo@hollo.social"
              required
              aria-invalid={error === "refresh" ? "true" : undefined}
            />
            <button name="submit" type="submit">
              Refresh
            </button>
          </fieldset>
          {error === "refresh" ? (
            <small>
              The given handle or URI is invalid or not found. Please try again.
            </small>
          ) : (
            <small>
              A fediverse handle (e.g., <tt>@hollo@hollo.social</tt>) or a
              post/actor URI (e.g.,{" "}
              <tt>
                https://hollo.social/@hollo/01904586-7b75-7ef6-ad31-bec40b8b1e66
              </tt>
              ) is allowed.
            </small>
          )}
        </form>
      </article>

      <article>
        <header>
          <hgroup>
            <h2>Relays</h2>
            <p>Manage relays.</p>
          </hgroup>
        </header>
        <form
          method="post"
          action="/federation/relay"
          onsubmit="this.submit.ariaBusy = 'true'"
        >
          <fieldset role="group">
            <input
              type="url"
              name="inbox_url"
              placeholder="https://relay.example.com/inbox"
              required
              aria-invalid={error === "invalid_relay" ? "true" : undefined}
            />
            <button name="submit" type="submit">
              Add
            </button>
          </fieldset>
          {error === "invalid_relay" ? (
            <small>The given relay URL is invalid. Please try again.</small>
          ) : error === "relay_alread_exists" ? (
            <small>The given relay URL already exists. Please try again.</small>
          ) : (
            <small>
              A relay conforming to{" "}
              <a href="https://codeberg.org/fediverse/fep/src/commit/a86d33f08cb3c17e294b1a280d74f71ee941ce44/fep/ae0c/fep-ae0c.md">
                FEP-ae0c
              </a>{" "}
              is supported.
            </small>
          )}
        </form>
        <table>
          <thead>
            <tr>
              <th>Inbox</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {relays.map((relay) => (
              <tr>
                <td>{relay.relayServerActor?.inboxUrl ?? relay.inboxUrl}</td>
                <td>{relay.state}</td>
                <td>
                  <form
                    method="post"
                    action={`/federation/relay/${encodeURIComponent(relay.followRequestId)}/delete`}
                  >
                    <button name="delete" type="submit">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article>
        <header>
          <hgroup>
            <h2>Task queue messages</h2>
            <p>The number of messages in the task queue.</p>
          </hgroup>
        </header>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th style="text-align: right">Number of messages</th>
            </tr>
          </thead>
          <tbody>
            {queueMessages.map((queueMessage) => (
              <tr>
                <td>{queueMessage.type}</td>
                <td style="text-align: right">
                  {queueMessage.number.toLocaleString("en")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article>
        <header>
          <hgroup>
            <h2>How to shut down your instance</h2>
            <p>
              So-called <q>self-destruct</q> your instance.
            </p>
          </hgroup>
        </header>
        <p>
          Hollo does not provide so-called <q>self-destruct</q> feature.
          However, you can achieve the same effect by deleting all{" "}
          <a href="/accounts">your accounts</a>.
        </p>
      </article>
    </DashboardLayout>,
  );
});

data.post("/refresh", async (c) => {
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const form = await c.req.formData();
  const uri = form.get("uri");
  const owner = await db.query.accountOwners.findFirst({});
  if (owner != null && typeof uri === "string") {
    const documentLoader = await fedCtx.getDocumentLoader({
      username: owner.handle,
    });
    try {
      const object = await fedCtx.lookupObject(uri, { documentLoader });
      if (isActor(object)) {
        await persistAccount(db, object, c.req.url, {
          ...fedCtx,
          documentLoader,
        });
        return c.redirect("/federation?done=refresh:account");
      }
      if (isPost(object)) {
        await persistPost(db, object, c.req.url, { ...fedCtx, documentLoader });
        return c.redirect("/federation?done=refresh:post");
      }
    } catch {}
  }
  return c.redirect("/federation?error=refresh");
});

data.post("/relay", async (c) => {
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const form = await c.req.formData();

  const inboxUrl = form.get("inbox_url");

  if (typeof inboxUrl !== "string") {
    return c.redirect("/federation?error=invalid_relay");
  }

  const [loadedRelay] = await db.transaction(async (tx) => {
    await tx
      .insert(instances)
      .values({
        host: fedCtx.host,
        software: "hollo",
        softwareVersion: null,
      })
      .onConflictDoNothing();

    const existingRelay = await tx.query.relays.findFirst({
      where: eq(relays.inboxUrl, inboxUrl),
    });

    if (existingRelay) {
      throw tx.rollback();
    }

    // Create client actor for the relay if it doesn't exist
    const account = await tx
      .insert(accounts)
      .values({
        id: HOLLO_RELAY_ACTOR_ID,
        iri: fedCtx.getActorUri(HOLLO_RELAY_ACTOR_USERNAME).href,
        instanceHost: fedCtx.host,
        type: "Application",
        name: HOLLO_RELAY_ACTOR_USERNAME,
        handle: `@${HOLLO_RELAY_ACTOR_USERNAME}@${fedCtx.host}`,
        url: fedCtx.getActorUri(HOLLO_RELAY_ACTOR_USERNAME).href,
        protected: false,
        inboxUrl: fedCtx.getInboxUri(HOLLO_RELAY_ACTOR_USERNAME).href,
        followersUrl: fedCtx.getFollowersUri(HOLLO_RELAY_ACTOR_USERNAME).href,
        sharedInboxUrl: fedCtx.getInboxUri().href,
        featuredUrl: fedCtx.getFeaturedUri(HOLLO_RELAY_ACTOR_USERNAME).href,
        published: new Date(),
      })
      .onConflictDoUpdate({
        target: accounts.id,
        set: {
          // Set anything to still return a value if the account already exists
          protected: false,
        },
      })
      .returning();

    const rsaKeyPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
    const ed25519KeyPair = await generateCryptoKeyPair("Ed25519");

    await tx
      .insert(accountOwners)
      .values({
        id: HOLLO_RELAY_ACTOR_ID,
        handle: HOLLO_RELAY_ACTOR_USERNAME,
        rsaPrivateKeyJwk: await exportJwk(rsaKeyPair.privateKey),
        rsaPublicKeyJwk: await exportJwk(rsaKeyPair.publicKey),
        ed25519PrivateKeyJwk: await exportJwk(ed25519KeyPair.privateKey),
        ed25519PublicKeyJwk: await exportJwk(ed25519KeyPair.publicKey),
        bio: "This account is an internal account used by Hollo. It is used to follow remote relays.",
        language: "en",
        // TODO: Which visibility should be set?
        visibility: "public",
        discoverable: false,
        themeColor: "pink",
      })
      .onConflictDoNothing()
      .returning();

    // Create follow request for this relay
    const followRequestId = new URL(
      `#relay-follows/${crypto.randomUUID()}`,
      account[0].iri,
    );

    // Create relay
    const [relay] = await tx
      .insert(relays)
      .values({
        state: "idle",
        relayClientActorId: HOLLO_RELAY_ACTOR_ID,
        followRequestId: followRequestId.href,
        inboxUrl,
      })
      .returning();

    const loadedRelay = await tx.query.relays.findFirst({
      where: eq(relays.inboxUrl, relay.inboxUrl),
      with: {
        relayClientActor: {
          with: {
            owner: true,
          },
        },
        relayServerActor: {
          with: {
            owner: true,
          },
        },
      },
    });

    if (!loadedRelay) {
      throw tx.rollback();
    }

    return [loadedRelay];
  });

  await fedCtx.sendActivity(
    { username: loadedRelay.relayClientActor.owner.handle },
    [
      {
        id: new URL(loadedRelay.inboxUrl),
        inboxId: new URL(loadedRelay.inboxUrl),
      },
    ],
    new RelayFollow({
      id: new URL(loadedRelay.followRequestId),
      actor: new URL(loadedRelay.relayClientActor.iri),
      object: new URL("https://www.w3.org/ns/activitystreams#Public"),
    }),
  );

  await db
    .update(relays)
    .set({
      state: "pending",
    })
    .where(eq(relays.inboxUrl, loadedRelay.inboxUrl));

  return c.redirect("/federation?done=relay:add");
});

data.post("/relay/:followRequestId/delete", async (c) => {
  const fedCtx = federation.createContext(c.req.raw, undefined);

  const followRequestId = decodeURIComponent(c.req.param("followRequestId"));

  await db.transaction(async (tx) => {
    const relay = await tx.query.relays.findFirst({
      where: eq(relays.followRequestId, followRequestId),
      with: {
        relayServerActor: {
          with: {
            owner: true,
          },
        },
        relayClientActor: {
          with: {
            owner: true,
          },
        },
      },
    });

    if (!relay) {
      throw new HTTPException(404, { res: await c.notFound() });
    }

    // Delete all outgoing activities for this relay
    await tx
      .delete(pgTable("fedify_message_v2", {}))
      .where(sql`"message"->>'inbox' = ${relay.inboxUrl}`);

    await fedCtx.sendActivity(
      { username: relay.relayClientActor.owner.handle },
      [
        {
          id: new URL(relay.relayServerActor?.iri ?? relay.inboxUrl),
          inboxId: new URL(relay.relayServerActor?.inboxUrl ?? relay.inboxUrl),
        },
      ],
      new RelayUndo({
        actor: new URL(relay.relayClientActor.iri),
        object: new RelayFollow({
          id: new URL(relay.followRequestId),
          actor: new URL(relay.relayClientActor.iri),
          object: new URL("https://www.w3.org/ns/activitystreams#Public"),
        }),
        published: Temporal.Now.instant(),
      }),
    );

    await tx.delete(relays).where(eq(relays.followRequestId, followRequestId));
  });

  return c.redirect("/federation?done=relay:removed");
});

export default data;
