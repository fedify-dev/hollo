import type { InboxContext } from "@fedify/fedify";
import {
  Article,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Update,
} from "@fedify/vocab";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import { accounts, instances, posts } from "../schema";
import type { Uuid } from "../uuid";
import { onPostUpdated } from "./inbox";

const ctx = {
  origin: "https://hollo.test",
} as InboxContext<void>;

async function seedRemoteAccount(host: string, username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://${host}/@${username}`;
  await db
    .insert(instances)
    .values({ host, software: "mastodon", softwareVersion: null })
    .onConflictDoNothing();
  await db.insert(accounts).values({
    id,
    iri,
    type: "Person",
    name: username,
    handle: `@${username}@${host}`,
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${iri}/inbox`,
    followersUrl: `${iri}/followers`,
    sharedInboxUrl: `https://${host}/inbox`,
    featuredUrl: `${iri}/featured`,
    instanceHost: host,
    published: new Date(),
  });
  const account = await db.query.accounts.findFirst({
    where: { id: { eq: id } },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

async function seedRemotePost(
  authorId: Uuid,
  authorIri: string,
  initialContent: string,
) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `${authorIri}/posts/${id}`;
  await db.insert(posts).values({
    id,
    iri,
    type: "Note",
    accountId: authorId,
    visibility: "public",
    contentHtml: `<p>${initialContent}</p>`,
    content: initialContent,
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return { id, iri };
}

describe("onPostUpdated", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("ignores Update from an actor on a different origin than the post", async () => {
    expect.assertions(2);
    const author = await seedRemoteAccount("remote.test", "author");
    const evil = await seedRemoteAccount("evil.test", "evil");
    const post = await seedRemotePost(author.id, author.iri, "original");

    const update = new Update({
      id: new URL(`${evil.iri}#update/${post.id}`),
      actor: new URL(evil.iri),
      object: new Note({
        id: new URL(post.iri),
        attribution: new Person({ id: new URL(author.iri) }),
        content: "hijacked",
        to: PUBLIC_COLLECTION,
      }),
    });

    await onPostUpdated(ctx, update);

    const after = await db.query.posts.findFirst({
      where: { iri: { eq: post.iri } },
    });
    expect(after?.content).toBe("original");
    expect(after?.contentHtml).toBe("<p>original</p>");
  });

  it("does not first-materialize a forged post whose id is on another origin", async () => {
    expect.assertions(1);
    const evil = await seedRemoteAccount("evil.test", "evil");
    const forgedIri = "https://remote.test/@author/posts/forged";

    const update = new Update({
      id: new URL(`${evil.iri}#update/forge`),
      actor: new URL(evil.iri),
      object: new Note({
        id: new URL(forgedIri),
        attribution: new Person({
          id: new URL("https://remote.test/@author"),
        }),
        content: "forged",
        to: PUBLIC_COLLECTION,
      }),
    });

    await onPostUpdated(ctx, update);

    const after = await db.query.posts.findFirst({
      where: { iri: { eq: forgedIri } },
    });
    expect(after).toBeUndefined();
  });

  it("does not first-materialize a post whose attribution origin differs from its id", async () => {
    expect.assertions(1);
    const evil = await seedRemoteAccount("evil.test", "evil");
    // Object id is on evil.test (matches Update actor), but attribution
    // claims a remote.test actor. The check must still refuse.
    const forgedIri = `${evil.iri}/posts/masquerade`;

    const update = new Update({
      id: new URL(`${evil.iri}#update/masquerade`),
      actor: new URL(evil.iri),
      object: new Note({
        id: new URL(forgedIri),
        attribution: new Person({
          id: new URL("https://remote.test/@author"),
        }),
        content: "masquerade",
        to: PUBLIC_COLLECTION,
      }),
    });

    await onPostUpdated(ctx, update);

    const after = await db.query.posts.findFirst({
      where: { iri: { eq: forgedIri } },
    });
    expect(after).toBeUndefined();
  });

  describe("Article titles", () => {
    async function seedArticle() {
      const author = await seedRemoteAccount("remote.test", "author");
      const id = crypto.randomUUID() as Uuid;
      const iri = `${author.iri}/articles/${id}`;
      await db.insert(posts).values({
        id,
        iri,
        type: "Article",
        accountId: author.id,
        visibility: "public",
        name: "Original title",
        contentHtml: "<p>Body</p>",
        content: "Body",
        published: new Date(),
        updated: new Date(),
      });
      return { author, iri };
    }

    async function update(
      author: { iri: string },
      object: (values: ConstructorParameters<typeof Note>[0]) => Article | Note,
      name: string | null,
      iri: string,
    ) {
      await onPostUpdated(
        ctx,
        new Update({
          id: new URL(`${iri}#update`),
          actor: new URL(author.iri),
          object: object({
            id: new URL(iri),
            attribution: new Person({
              id: new URL(author.iri),
              name: "author",
              inbox: new URL(`${author.iri}/inbox`),
            }),
            name,
            content: "<p>Edited body</p>",
            to: PUBLIC_COLLECTION,
          }),
        }),
      );
      return await db.query.posts.findFirst({ where: { iri: { eq: iri } } });
    }

    it("replaces the title", async () => {
      expect.assertions(2);
      const { author, iri } = await seedArticle();
      const after = await update(
        author,
        (values) => new Article(values),
        "New title",
        iri,
      );
      expect(after?.name).toBe("New title");
      expect(after?.contentHtml).toBe("<p>Edited body</p>");
    });

    it("clears a removed title", async () => {
      expect.assertions(2);
      const { author, iri } = await seedArticle();
      const after = await update(
        author,
        (values) => new Article(values),
        null,
        iri,
      );
      expect(after?.name).toBeNull();
      expect(after?.contentHtml).toBe("<p>Edited body</p>");
    });

    it("clears a whitespace-only title", async () => {
      expect.assertions(1);
      const { author, iri } = await seedArticle();
      const after = await update(
        author,
        (values) => new Article(values),
        "  ",
        iri,
      );
      expect(after?.name).toBeNull();
    });

    it("clears the title when the Article becomes a Note", async () => {
      expect.assertions(2);
      const { author, iri } = await seedArticle();
      const after = await update(
        author,
        (values) => new Note(values),
        "Original title",
        iri,
      );
      expect(after?.type).toBe("Note");
      expect(after?.name).toBeNull();
    });
  });
});
