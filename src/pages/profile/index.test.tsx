import { eq } from "drizzle-orm";
import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import { createAccount } from "../../../tests/helpers/oauth";
import db from "../../db";
import {
  accountOwners,
  accounts,
  featuredTags,
  instances,
  media,
  pollOptions,
  polls,
  posts,
} from "../../schema";
import { uuidv7 } from "../../uuid";
import app from "../index";

describe.sequential("profile tagged page", () => {
  let account: Awaited<ReturnType<typeof createAccount>>;

  beforeEach(async () => {
    await cleanDatabase();
    account = await createAccount();
  });

  it("shows only the profile user's matching tagged posts", async () => {
    expect.assertions(6);

    const taggedPostId = uuidv7();
    const otherPostId = uuidv7();
    const privateTaggedPostId = uuidv7();

    await db.insert(posts).values([
      {
        id: taggedPostId,
        iri: `https://hollo.test/@hollo/${taggedPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Matching profile tag post",
        contentHtml: "<p>Matching profile tag post</p>",
        tags: {
          "#testtag": "https://hollo.test/tags/TestTag",
        },
        published: new Date(),
      },
      {
        id: otherPostId,
        iri: `https://hollo.test/@hollo/${otherPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Different tag post",
        contentHtml: "<p>Different tag post</p>",
        tags: {
          "#othertag": "https://hollo.test/tags/OtherTag",
        },
        published: new Date(),
      },
      {
        id: privateTaggedPostId,
        iri: `https://hollo.test/@hollo/${privateTaggedPostId}`,
        type: "Note",
        accountId: account.id,
        visibility: "private",
        content: "Private matching tag post",
        contentHtml: "<p>Private matching tag post</p>",
        tags: {
          "#testtag": "https://hollo.test/tags/TestTag",
        },
        published: new Date(),
      },
    ]);

    const response = await app.request("/@hollo/tagged/TestTag");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("Posts tagged");
    expect(html).toContain("#TestTag");
    expect(html).toContain("Matching profile tag post");
    expect(html).not.toContain("Different tag post");
    expect(html).not.toContain("Private matching tag post");
  });

  it("marks profile tag labels with the owner's default language", async () => {
    expect.assertions(5);

    await db
      .update(accountOwners)
      .set({ language: "ko" })
      .where(eq(accountOwners.id, account.id));
    await db.insert(featuredTags).values({
      id: uuidv7(),
      accountOwnerId: account.id,
      name: "TestTag",
      created: new Date(),
    });

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const { document } = parseHTML(await response.text());
    const featuredTag = document.querySelector(
      'a[href="/@hollo/tagged/TestTag"]',
    );

    expect(featuredTag?.textContent?.trim()).toBe("#TestTag");
    expect(featuredTag?.getAttribute("lang")).toBe("ko");

    const taggedResponse = await app.request("/@hollo/tagged/TestTag");

    expect(taggedResponse.status).toBe(200);

    const taggedPage = parseHTML(await taggedResponse.text()).document;

    expect(taggedPage.querySelector("h2 span")?.getAttribute("lang")).toBe(
      "ko",
    );
  });

  it("marks profile-authored text with the owner's default language", async () => {
    expect.assertions(4);

    await db
      .update(accountOwners)
      .set({ language: "ko" })
      .where(eq(accountOwners.id, account.id));
    await db
      .update(accounts)
      .set({
        name: "테스트 사용자",
        bioHtml: "<p>안녕하세요.</p>",
        fieldHtmls: { 웹사이트: "<p>https://hollo.test/</p>" },
      })
      .where(eq(accounts.id, account.id));

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const { document } = parseHTML(await response.text());
    const profile = document.querySelector("main > header");

    expect(profile?.querySelector("h1 a")?.getAttribute("lang")).toBe("ko");
    expect(profile?.querySelector(".prose")?.getAttribute("lang")).toBe("ko");
    expect(profile?.querySelector("dl > div")?.getAttribute("lang")).toBe("ko");
  });

  it("marks poll option titles with the post language", async () => {
    expect.assertions(3);

    const pollId = uuidv7();
    const postId = uuidv7();
    await db.transaction(async (tx) => {
      await tx.insert(polls).values({
        id: pollId,
        expires: new Date(Date.now() + 60_000),
      });
      await tx.insert(pollOptions).values({
        pollId,
        index: 0,
        title: "中文選項",
      });
      await tx.insert(posts).values({
        id: postId,
        iri: `https://hollo.test/@hollo/${postId}`,
        type: "Question",
        accountId: account.id,
        visibility: "public",
        content: "請選擇",
        contentHtml: "<p>請選擇</p>",
        language: "zh-Hant",
        pollId,
        published: new Date(),
      });
    });

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const { document } = parseHTML(await response.text());
    const option = document.querySelector("article ul li span[lang]");

    expect(option?.textContent?.trim()).toBe("中文選項");
    expect(option?.getAttribute("lang")).toBe("zh-Hant");
  });

  it("marks known account and attachment text with their languages", async () => {
    expect.assertions(5);

    await db
      .update(accountOwners)
      .set({ language: "ko" })
      .where(eq(accountOwners.id, account.id));
    await db
      .update(accounts)
      .set({ name: "테스트 사용자" })
      .where(eq(accounts.id, account.id));

    const replyTargetId = uuidv7();
    const replyTargetIri = `https://hollo.test/@hollo/${replyTargetId}`;
    const postId = uuidv7();
    await db.transaction(async (tx) => {
      await tx.insert(posts).values([
        {
          id: replyTargetId,
          iri: replyTargetIri,
          type: "Note",
          accountId: account.id,
          visibility: "private",
          content: "Reply target",
          contentHtml: "<p>Reply target</p>",
          language: "en",
          published: new Date(),
        },
        {
          id: postId,
          iri: `https://hollo.test/@hollo/${postId}`,
          type: "Note",
          accountId: account.id,
          replyTargetId,
          visibility: "public",
          content: "画像付き投稿",
          contentHtml: "<p>画像付き投稿</p>",
          language: "ja",
          published: new Date(),
        },
      ]);
      await tx.insert(media).values({
        id: uuidv7(),
        postId,
        type: "image/png",
        url: "https://hollo.test/media/image.png",
        width: 640,
        height: 480,
        description: "画像の説明",
        thumbnailType: "image/png",
        thumbnailUrl: "https://hollo.test/media/image-thumbnail.png",
        thumbnailWidth: 320,
        thumbnailHeight: 240,
      });
    });

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const { document } = parseHTML(await response.text());
    const post = document.querySelector("article");

    expect(post?.querySelector("header a[lang]")?.getAttribute("lang")).toBe(
      "ko",
    );
    expect(
      post?.querySelector(`a[href="${replyTargetIri}"]`)?.getAttribute("lang"),
    ).toBe("ko");
    expect(post?.querySelector("figcaption p")?.getAttribute("lang")).toBe(
      "ja",
    );
    expect(
      post?.querySelector('img[alt="画像の説明"]')?.getAttribute("lang"),
    ).toBe("ja");
  });

  it("marks profiles whose account has moved", async () => {
    expect.assertions(7);

    const successor = await createAccount({ username: "newhome" });
    await db
      .update(accounts)
      .set({
        avatarUrl: "https://hollo.test/avatar.png",
        coverUrl: "https://hollo.test/cover.png",
        successorId: successor.id,
      })
      .where(eq(accounts.id, account.id));

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("This account has moved to:");
    expect(html).toContain("Test: newhome");
    expect(html).toContain("@newhome@hollo.test");
    expect(html).toContain('href="https://hollo.test/@newhome"');
    expect(html).toContain("View profile");
    expect(html).toContain("grayscale opacity-60");
  });

  it("shows the moved-account notice on profile collection pages", async () => {
    expect.assertions(4);

    const successor = await createAccount({ username: "newhome" });
    await db
      .update(accounts)
      .set({ successorId: successor.id })
      .where(eq(accounts.id, account.id));

    const response = await app.request("/@hollo/followers");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("This account has moved to:");
    expect(html).toContain("@newhome@hollo.test");
    expect(html).toContain("No followers yet.");
  });

  it("hides quote-inline fallback content on profile pages", async () => {
    expect.assertions(5);

    const quotedPostId = uuidv7();
    const quotePostId = uuidv7();
    const quotedPostUrl = `https://hollo.test/@hollo/${quotedPostId}`;

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: quotedPostUrl,
        type: "Note",
        accountId: account.id,
        visibility: "public",
        content: "Quoted post",
        contentHtml: "<p>Quoted post</p>",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://hollo.test/@hollo/${quotePostId}`,
        type: "Note",
        accountId: account.id,
        quoteTargetId: quotedPostId,
        visibility: "public",
        content: "Quote post",
        contentHtml:
          "<p>Quote post</p>" +
          `<p class="quote-inline">RE: <a href="${quotedPostUrl}">` +
          `${quotedPostUrl}</a></p>`,
        published: new Date(),
      },
    ]);

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("Quote post");
    expect(html).toContain("Quoted post");
    expect(html).not.toContain("quote-inline");
    expect(html).not.toContain("RE:");
  });

  it("keeps quote-inline fallback content without a rendered quote", async () => {
    expect.assertions(5);

    const postId = uuidv7();
    const quotedPostUrl = "https://remote.test/notes/missing";

    await db.insert(posts).values({
      id: postId,
      iri: `https://hollo.test/@hollo/${postId}`,
      type: "Note",
      accountId: account.id,
      visibility: "public",
      content: "Quote post",
      contentHtml:
        "<p>Quote post</p>" +
        `<p class="quote-inline">RE: <a href="${quotedPostUrl}">` +
        `${quotedPostUrl}</a></p>`,
      published: new Date(),
    });

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("Quote post");
    expect(html).toContain("quote-inline");
    expect(html).toContain("RE:");
    expect(html).toContain(quotedPostUrl);
  });

  it.each([
    ["revoked", "revoked approval"],
    ["rejected", "did not approve"],
    ["pending", "awaiting the author"],
    ["unauthorized", "not authorized"],
  ] as const)(
    "hides %s quote source behind a placeholder on profile pages",
    async (state, expectedMessageFragment) => {
      expect.assertions(6);

      const remoteAccountId = uuidv7();
      await db
        .insert(instances)
        .values({
          host: "remote.test",
          software: null,
          softwareVersion: null,
        })
        .onConflictDoNothing();
      await db.insert(accounts).values({
        id: remoteAccountId,
        iri: "https://remote.test/@quoted",
        instanceHost: "remote.test",
        type: "Person",
        name: "Quoted Author",
        emojis: {},
        handle: "@quoted@remote.test",
        bioHtml: "",
        url: "https://remote.test/@quoted",
        protected: false,
        inboxUrl: "https://remote.test/@quoted/inbox",
        followersUrl: "https://remote.test/@quoted/followers",
        sharedInboxUrl: "https://remote.test/inbox",
        featuredUrl: "https://remote.test/@quoted/pinned",
        published: new Date(),
      });

      const quotedPostId = uuidv7();
      const quotePostId = uuidv7();
      const quotedPostUrl = `https://remote.test/notes/${quotedPostId}`;

      await db.insert(posts).values([
        {
          id: quotedPostId,
          iri: quotedPostUrl,
          type: "Note",
          accountId: remoteAccountId,
          visibility: "public",
          content: "Quoted post",
          contentHtml: "<p>Quoted post body</p>",
          published: new Date(),
        },
        {
          id: quotePostId,
          iri: `https://hollo.test/@hollo/${quotePostId}`,
          type: "Note",
          accountId: account.id,
          quoteTargetId: quotedPostId,
          quoteState: state,
          visibility: "public",
          content: "Quote post",
          contentHtml:
            "<p>Quote post</p>" +
            `<p class="quote-inline">RE: <a href="${quotedPostUrl}">` +
            `${quotedPostUrl}</a></p>`,
          published: new Date(),
        },
      ]);

      const response = await app.request("/@hollo");

      expect(response.status).toBe(200);

      const html = await response.text();

      expect(html).toContain("Quote post");
      expect(html).not.toContain("Quoted post body");
      expect(html).toContain("quote-inline");
      expect(html).toContain(quotedPostUrl);
      expect(html.toLowerCase()).toContain(expectedMessageFragment);
    },
  );

  it(
    "does not render a stale placeholder when an accepted quote target " +
      "is itself a quote",
    async () => {
      expect.assertions(4);

      const innerQuotedPostId = uuidv7();
      const middleQuotePostId = uuidv7();
      const outerQuotePostId = uuidv7();
      const innerQuotedPostUrl = `https://hollo.test/@hollo/${innerQuotedPostId}`;
      const middleQuotePostUrl = `https://hollo.test/@hollo/${middleQuotePostId}`;

      await db.insert(posts).values([
        {
          id: innerQuotedPostId,
          iri: innerQuotedPostUrl,
          type: "Note",
          accountId: account.id,
          visibility: "public",
          content: "Innermost post",
          contentHtml: "<p>Innermost post body</p>",
          published: new Date(),
        },
        {
          id: middleQuotePostId,
          iri: middleQuotePostUrl,
          type: "Note",
          accountId: account.id,
          quoteTargetId: innerQuotedPostId,
          quoteState: "accepted",
          visibility: "public",
          content: "Middle quote",
          contentHtml: "<p>Middle quote body</p>",
          published: new Date(),
        },
        {
          id: outerQuotePostId,
          iri: `https://hollo.test/@hollo/${outerQuotePostId}`,
          type: "Note",
          accountId: account.id,
          quoteTargetId: middleQuotePostId,
          quoteState: "accepted",
          visibility: "public",
          content: "Outer quote",
          contentHtml: "<p>Outer quote body</p>",
          published: new Date(),
        },
      ]);

      const response = await app.request("/@hollo");

      expect(response.status).toBe(200);

      const html = await response.text();

      expect(html).toContain("Outer quote body");
      expect(html).toContain("Middle quote body");
      expect(html.toLowerCase()).not.toContain("no longer available");
    },
  );

  it("shows a placeholder when the quoted post no longer exists", async () => {
    expect.assertions(3);

    const quotePostId = uuidv7();

    await db.insert(posts).values({
      id: quotePostId,
      iri: `https://hollo.test/@hollo/${quotePostId}`,
      type: "Note",
      accountId: account.id,
      quoteTargetIri: "https://remote.test/notes/gone",
      quoteState: "accepted",
      visibility: "public",
      content: "Quote post",
      contentHtml: "<p>Quote post</p>",
      published: new Date(),
    });

    const response = await app.request("/@hollo");

    expect(response.status).toBe(200);

    const html = await response.text();

    expect(html).toContain("Quote post");
    expect(html.toLowerCase()).toContain("no longer available");
  });
});
