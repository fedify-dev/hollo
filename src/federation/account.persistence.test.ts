import { Person } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import * as Schema from "../schema";
import type { Uuid } from "../uuid";
import {
  AccountHandleConflictError,
  persistAccount,
  updateAccountStats,
} from "./account";

async function createRemoteAccount(params: {
  iri: string;
  handle: string;
  name?: string;
  url?: string;
}): Promise<Schema.Account> {
  const host = new URL(params.iri).host;
  await db
    .insert(Schema.instances)
    .values({
      host,
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();

  const [account] = await db
    .insert(Schema.accounts)
    .values({
      id: crypto.randomUUID() as Uuid,
      iri: params.iri,
      type: "Person",
      name: params.name ?? "Remote account",
      handle: params.handle,
      bioHtml: "",
      url: params.url ?? params.iri,
      protected: false,
      inboxUrl: `${params.iri}/inbox`,
      followersUrl: `${params.iri}/followers`,
      sharedInboxUrl: `https://${host}/inbox`,
      featuredUrl: `${params.iri}/featured`,
      fieldHtmls: {},
      emojis: {},
      aliases: [],
      instanceHost: host,
      published: new Date("2023-03-04T00:00:00Z"),
    })
    .returning();

  return account;
}

async function createLocalPost(accountId: Uuid): Promise<Schema.Post> {
  const [post] = await db
    .insert(Schema.posts)
    .values({
      id: crypto.randomUUID() as Uuid,
      iri: `https://hollo.test/posts/${crypto.randomUUID()}`,
      type: "Note",
      accountId,
      visibility: "public",
      summary: null,
      contentHtml: "<p>Hello</p>",
      content: "Hello",
      language: "en",
      tags: {},
      emojis: {},
      sensitive: false,
      updated: new Date(),
      published: new Date(),
    })
    .returning();

  return post;
}

function createRemotePerson(iri: string, username: string): Person {
  return new Person({
    id: new URL(iri),
    preferredUsername: username,
    name: "Michael Foster",
    inbox: new URL(`${iri}/inbox`),
    url: new URL(`https://${new URL(iri).host}/@${username}`),
  });
}

function mockCanonicalOwnership(handle: string, actorIri: string): void {
  const acctUri = `acct:${handle.replace(/^@/, "")}`;
  const username = handle.replace(/^@/, "").replace(/@[^@]+$/, "");
  const profileUrl = `https://${new URL(actorIri).host}/@${username}`;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(requestUrl);
      const resource = url.searchParams.get("resource");

      if (url.pathname === "/.well-known/webfinger" && resource === actorIri) {
        return new Response(
          JSON.stringify({
            subject: acctUri,
            aliases: [profileUrl, actorIri],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/jrd+json" },
          },
        );
      }
      if (url.pathname === "/.well-known/webfinger" && resource === acctUri) {
        return new Response(
          JSON.stringify({
            subject: acctUri,
            aliases: [profileUrl, actorIri],
            links: [
              {
                rel: "self",
                type: "application/activity+json",
                href: actorIri,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/jrd+json" },
          },
        );
      }
      return new Response(null, { status: 404 });
    }),
  );
}

describe.sequential("persistAccount canonical handle reassignment", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deletes a stale remote account and its dependent data when an existing actor row reclaims the canonical handle", async () => {
    expect.assertions(9);

    const localOwner = await createAccount();
    const localPost = await createLocalPost(localOwner.id as Uuid);
    const staleAccount = await createRemoteAccount({
      iri: "https://newsmast.social/users/michael",
      handle: "@michael@newsmast.social",
      url: "https://newsmast.social/@michael",
    });
    const currentAccount = await createRemoteAccount({
      iri: "https://backend.newsmast.org/users/michael",
      handle: "@michael@backend.newsmast.org",
      url: "https://backend.newsmast.org/@michael",
    });

    await db.insert(Schema.posts).values({
      id: crypto.randomUUID() as Uuid,
      iri: "https://newsmast.social/posts/old-michael-post",
      type: "Note",
      accountId: staleAccount.id,
      visibility: "public",
      contentHtml: "<p>Old post</p>",
      content: "Old post",
      tags: {},
      emojis: {},
      sensitive: false,
      updated: new Date(),
      published: new Date(),
    });
    await db.insert(Schema.mentions).values({
      postId: localPost.id,
      accountId: staleAccount.id,
    });
    await db.insert(Schema.follows).values([
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: staleAccount.id,
        followerId: localOwner.id as Uuid,
        approved: new Date(),
      },
      {
        iri: `https://remote.test/follows/${crypto.randomUUID()}`,
        followingId: localOwner.id as Uuid,
        followerId: staleAccount.id,
        approved: new Date(),
      },
    ]);
    await updateAccountStats(db, { id: localOwner.id as Uuid });

    mockCanonicalOwnership(
      "@michael@newsmast.social",
      "https://backend.newsmast.org/users/michael",
    );

    const account = await persistAccount(
      db,
      createRemotePerson(
        "https://backend.newsmast.org/users/michael",
        "michael",
      ),
      "https://hollo.test",
    );

    const localAfter = await db.query.accounts.findFirst({
      where: eq(Schema.accounts.id, localOwner.id as Uuid),
    });
    const staleAfter = await db.query.accounts.findFirst({
      where: eq(Schema.accounts.id, staleAccount.id),
    });
    const stalePosts = await db.query.posts.findMany({
      where: eq(Schema.posts.accountId, staleAccount.id),
    });
    const mentions = await db.query.mentions.findMany({
      where: eq(Schema.mentions.accountId, staleAccount.id),
    });

    expect(account?.id).toBe(currentAccount.id);
    expect(account?.handle).toBe("@michael@newsmast.social");
    expect(account?.url).toBe("https://backend.newsmast.org/@michael");
    expect(staleAfter).toBeUndefined();
    expect(stalePosts).toHaveLength(0);
    expect(mentions).toHaveLength(0);
    expect(localAfter?.followingCount).toBe(0);
    expect(localAfter?.followersCount).toBe(0);
    expect(account?.instanceHost).toBe("backend.newsmast.org");
  });

  it("deletes a stale remote account before inserting a newly discovered actor that now owns the canonical handle", async () => {
    expect.assertions(4);

    const staleAccount = await createRemoteAccount({
      iri: "https://newsmast.social/users/michael",
      handle: "@michael@newsmast.social",
      url: "https://newsmast.social/@michael",
    });

    mockCanonicalOwnership(
      "@michael@newsmast.social",
      "https://backend.newsmast.org/users/michael",
    );

    const account = await persistAccount(
      db,
      createRemotePerson(
        "https://backend.newsmast.org/users/michael",
        "michael",
      ),
      "https://hollo.test",
    );

    const staleAfter = await db.query.accounts.findFirst({
      where: eq(Schema.accounts.id, staleAccount.id),
    });

    expect(account?.iri).toBe("https://backend.newsmast.org/users/michael");
    expect(account?.handle).toBe("@michael@newsmast.social");
    expect(staleAfter).toBeUndefined();
    expect(account?.url).toBe("https://backend.newsmast.org/@michael");
  });

  it("refuses to delete a local account that still owns the canonical handle", async () => {
    expect.assertions(3);

    const canonicalHandle = "@hollo@1.1.1.1";
    const actorIri = "https://8.8.8.8/users/hollo";
    await createAccount({ username: "hollo" });
    await db.update(Schema.accounts).set({ handle: canonicalHandle });
    mockCanonicalOwnership(canonicalHandle, actorIri);

    await expect(
      persistAccount(
        db,
        createRemotePerson(actorIri, "hollo"),
        "https://hollo.test",
      ),
    ).rejects.toThrow(AccountHandleConflictError);

    try {
      await persistAccount(
        db,
        createRemotePerson(actorIri, "hollo"),
        "https://hollo.test",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AccountHandleConflictError);
      expect((error as AccountHandleConflictError).reason).toBe("local");
    }
  });
});
