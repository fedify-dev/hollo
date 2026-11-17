import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import type { Account } from "../schema";
import { Post, type PostProps } from "./Post";

const now = new Date("2026-01-01T00:00:00Z");
const account: Account = {
  id: "00000000-0000-4000-8000-000000000001",
  iri: "https://remote.example/actor",
  type: "Person",
  name: "Remote author",
  handle: "@remote@remote.example",
  bioHtml: null,
  url: null,
  protected: false,
  avatarUrl: null,
  coverUrl: null,
  inboxUrl: "https://remote.example/inbox",
  followersUrl: null,
  sharedInboxUrl: null,
  featuredUrl: null,
  followingCount: 0,
  followersCount: 0,
  postsCount: 0,
  fieldHtmls: {},
  emojis: {},
  sensitive: false,
  successorId: null,
  aliases: [],
  instanceHost: "remote.example",
  published: now,
  updated: now,
  fetched: now,
};

function makePost(
  overrides: Partial<PostProps["post"]> = {},
): PostProps["post"] {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    iri: "https://remote.example/note",
    type: "Note",
    accountId: account.id,
    account,
    applicationId: null,
    replyTargetId: null,
    sharingId: null,
    quoteTargetId: null,
    visibility: "public",
    summary: null,
    contentHtml: "<p>Hello</p>",
    content: "Hello",
    pollId: null,
    language: "en",
    tags: {},
    emojis: {},
    sensitive: false,
    url: null,
    previewCard: null,
    repliesCount: 0,
    sharesCount: 0,
    likesCount: 0,
    quotesCount: 0,
    idempotenceKey: null,
    published: now,
    updated: now,
    media: [],
    poll: null,
    sharing: null,
    replyTarget: null,
    quoteTarget: null,
    reactions: [],
    ...overrides,
  };
}

function renderPost(post: PostProps["post"]) {
  return parseHTML((<Post post={post} />).toString()).document;
}

const maliciousBody =
  '<p>Reply<img src="x" onerror="alert(1)">' +
  '<a href="javascript:alert(2)">link</a></p>' +
  '<script>alert(3)</script><svg onload="alert(4)"></svg>';

describe("Post", () => {
  it.each(["reply", "boost", "quote"] as const)(
    "sanitizes stored HTML in a remote %s",
    (kind) => {
      const remote = makePost({
        contentHtml: maliciousBody,
        replyTarget: makePost(),
      });
      const post =
        kind === "boost"
          ? makePost({ sharing: remote })
          : kind === "quote"
            ? makePost({ quoteTarget: remote })
            : remote;
      const document = renderPost(post);

      expect(
        document.querySelectorAll("script, [onerror], [onload]"),
      ).toHaveLength(0);
      expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
      expect(document.querySelector("svg")).not.toBeNull();
      expect(document.querySelector("article")?.textContent).toContain("Reply");
      expect(remote.contentHtml).toBe(maliciousBody);
    },
  );

  it("escapes display names as text, even when they look like HTML", () => {
    const name = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    const document = renderPost(makePost({ account: { ...account, name } }));

    expect(document.querySelector("h5 a")?.textContent).toBe(name);
    expect(document.querySelectorAll("img, script")).toHaveLength(0);
  });

  it.each([
    'https://remote.example/e" onerror="alert(1)',
    'https://remote.example/e"><script>alert(1)</script>',
    "https://remote.example/e?a=1&literal=&quot;&amp;",
  ])("safely expands both body and author emojis: %s", (url) => {
    const document = renderPost(
      makePost({
        account: { ...account, name: "Author :hello:", emojis: { hello: url } },
        contentHtml: "<p>Body :hello:</p>",
        emojis: { ":hello:": url },
      }),
    );
    const images = document.querySelectorAll("img");

    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.getAttribute("src")).toBe(url);
      expect(image.getAttribute("alt")).toBe(":hello:");
      expect(image.getAttribute("style")).toBe("height: 1em");
      expect(image.getAttributeNames().sort()).toEqual(["alt", "src", "style"]);
    }
    expect(document.querySelectorAll("script, [onerror]")).toHaveLength(0);
  });

  it("preserves rich text, safe links and normal custom emoji presentation", () => {
    const document = renderPost(
      makePost({
        account: {
          ...account,
          name: "Author & :hello:",
          emojis: { hello: "https://remote.example/author.png" },
        },
        contentHtml:
          '<p lang="en"><em>Hello</em> <strong>world</strong> :hello: ' +
          '<a href="https://remote.example/@user" class="mention">@user</a> ' +
          '<a href="https://remote.example/tags/test" class="hashtag">#test</a></p>' +
          "<ul><li>item</li></ul>",
        emojis: { hello: "https://remote.example/post.png" },
      }),
    );

    expect(document.querySelector('p[lang="en"] em')?.textContent).toBe(
      "Hello",
    );
    expect(document.querySelector("strong")?.textContent).toBe("world");
    expect(document.querySelector("ul li")?.textContent).toBe("item");
    expect(document.querySelector("a.mention")?.getAttribute("href")).toBe(
      "https://remote.example/@user",
    );
    expect(document.querySelector("a.hashtag")?.textContent).toBe("#test");
    expect(document.querySelector("h5 a")?.textContent).toBe("Author & ");
    expect(document.querySelector("h5 img")?.getAttribute("src")).toBe(
      "https://remote.example/author.png",
    );
    expect(document.querySelector("p img")?.getAttribute("src")).toBe(
      "https://remote.example/post.png",
    );
    expect(document.querySelector("p img")?.getAttribute("style")).toBe(
      "height: 1em",
    );
  });

  it("keeps the summary escaped", () => {
    const summary = '<img src=x onerror="alert(1)">';
    const document = renderPost(makePost({ summary }));

    expect(document.querySelector("summary")?.textContent).toBe(summary);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it.each([null, "", "<script>alert(1)</script>"])(
    "handles an empty or script-only body: %s",
    (contentHtml) => {
      const document = renderPost(makePost({ contentHtml }));

      expect(document.querySelector("article")).not.toBeNull();
      expect(document.querySelector("script")).toBeNull();
    },
  );
});
