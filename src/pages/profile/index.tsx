import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import xss from "xss";

import { Layout } from "../../components/Layout.tsx";
import { Post as PostView } from "../../components/Post.tsx";
import { Profile } from "../../components/Profile.tsx";
import { db } from "../../db.ts";
import {
  type Account,
  type AccountOwner,
  accountOwners,
  type FeaturedTag,
  featuredTags,
  type Medium,
  type Poll,
  type PollOption,
  type Post,
  pinnedPosts,
  posts,
  type Reaction,
} from "../../schema.ts";
import { isUuid } from "../../uuid.ts";
import profilePost from "./profilePost.tsx";

const profile = new Hono();

profile.route("/:id{[-a-f0-9]+}", profilePost);

const PAGE_SIZE = 30;

profile.get<"/:handle">(async (c) => {
  let handle = c.req.param("handle");
  if (handle.startsWith("@")) handle = handle.substring(1);
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, handle),
    with: { account: true },
  });
  if (owner == null) return c.notFound();
  const contStr = c.req.query("cont");
  const cont = contStr == null || contStr.trim() === "" ? undefined : contStr;
  if (cont != null && !isUuid(cont)) return c.notFound();
  const pageStr = c.req.query("page");
  if (
    pageStr !== undefined &&
    (Number.isNaN(Number.parseInt(pageStr, 10)) ||
      Number.parseInt(pageStr, 10) < 1)
  ) {
    return c.notFound();
  }
  const page =
    pageStr !== undefined && !Number.isNaN(Number.parseInt(pageStr, 10))
      ? Number.parseInt(pageStr, 10)
      : 1;
  const [{ totalPosts }] = await db
    .select({ totalPosts: count() })
    .from(posts)
    .where(
      and(
        eq(posts.accountId, owner.id),
        or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      ),
    );
  const maxPage = Math.ceil(totalPosts / PAGE_SIZE);
  if (page > maxPage && !(page <= 1 && totalPosts < 1)) {
    return c.notFound();
  }
  const postList = await db.query.posts.findMany({
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
    ),
    orderBy: desc(posts.id),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    with: {
      account: true,
      media: true,
      poll: { with: { options: true } },
      sharing: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          quoteTarget: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              reactions: true,
            },
          },
          reactions: true,
        },
      },
      replyTarget: { with: { account: true } },
      quoteTarget: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          reactions: true,
        },
      },
      reactions: true,
    },
  });
  const pinnedPostList =
    cont == null
      ? await db.query.pinnedPosts.findMany({
          where: and(eq(pinnedPosts.accountId, owner.id)),
          orderBy: desc(pinnedPosts.index),
          with: {
            post: {
              with: {
                account: true,
                media: true,
                poll: { with: { options: true } },
                sharing: {
                  with: {
                    account: true,
                    media: true,
                    poll: { with: { options: true } },
                    replyTarget: { with: { account: true } },
                    quoteTarget: {
                      with: {
                        account: true,
                        media: true,
                        poll: { with: { options: true } },
                        replyTarget: { with: { account: true } },
                        reactions: true,
                      },
                    },
                    reactions: true,
                  },
                },
                replyTarget: { with: { account: true } },
                quoteTarget: {
                  with: {
                    account: true,
                    media: true,
                    poll: { with: { options: true } },
                    replyTarget: { with: { account: true } },
                    reactions: true,
                  },
                },
                reactions: true,
              },
            },
          },
        })
      : [];
  const featuredTagList = await db.query.featuredTags.findMany({
    where: eq(featuredTags.accountOwnerId, owner.id),
  });
  const atomUrl = new URL(c.req.url);
  atomUrl.pathname += "/atom.xml";
  atomUrl.search = "";
  const newerUrl = page > 1 ? `?page=${page - 1}` : undefined;
  const olderUrl =
    postList.length === PAGE_SIZE ? `?page=${page + 1}` : undefined;
  return c.html(
    <ProfilePage
      accountOwner={owner}
      posts={postList.slice(0, PAGE_SIZE)}
      pinnedPosts={pinnedPostList
        .map((p) => p.post)
        .filter(
          (p) => p.visibility === "public" || p.visibility === "unlisted",
        )}
      featuredTags={featuredTagList}
      atomUrl={atomUrl.href}
      olderUrl={olderUrl}
      newerUrl={newerUrl}
    />,
  );
});

profile.get("/tagged/:tag", async (c) => {
  let handle = c.req.param("handle");
  const tag = c.req.param("tag");
  if (handle == null || tag == null) return c.notFound();
  if (handle.startsWith("@")) handle = handle.substring(1);
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, handle),
    with: { account: true },
  });
  if (owner == null) return c.notFound();
  const hashtag = `${tag.startsWith("#") ? tag : `#${tag}`}`.toLowerCase();
  const pageStr = c.req.query("page");
  if (
    pageStr !== undefined &&
    (Number.isNaN(Number.parseInt(pageStr, 10)) ||
      Number.parseInt(pageStr, 10) < 1)
  ) {
    return c.notFound();
  }
  const page =
    pageStr !== undefined && !Number.isNaN(Number.parseInt(pageStr, 10))
      ? Number.parseInt(pageStr, 10)
      : 1;
  const [{ totalPosts }] = await db
    .select({ totalPosts: count() })
    .from(posts)
    .where(
      and(
        eq(posts.accountId, owner.id),
        or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        sql`${posts.tags} ? ${hashtag}`,
      ),
    );
  const maxPage = Math.ceil(totalPosts / PAGE_SIZE);
  if (page > maxPage && !(page <= 1 && totalPosts < 1)) {
    return c.notFound();
  }
  const postList = await db.query.posts.findMany({
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
      sql`${posts.tags} ? ${hashtag}`,
    ),
    orderBy: desc(posts.id),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    with: {
      account: true,
      media: true,
      poll: { with: { options: true } },
      sharing: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          quoteTarget: {
            with: {
              account: true,
              media: true,
              poll: { with: { options: true } },
              replyTarget: { with: { account: true } },
              reactions: true,
            },
          },
          reactions: true,
        },
      },
      replyTarget: { with: { account: true } },
      quoteTarget: {
        with: {
          account: true,
          media: true,
          poll: { with: { options: true } },
          replyTarget: { with: { account: true } },
          reactions: true,
        },
      },
      reactions: true,
    },
  });
  const featuredTagList = await db.query.featuredTags.findMany({
    where: eq(featuredTags.accountOwnerId, owner.id),
  });
  const newerUrl = page > 1 ? `?page=${page - 1}` : undefined;
  const olderUrl =
    postList.length === PAGE_SIZE ? `?page=${page + 1}` : undefined;
  return c.html(
    <ProfilePage
      accountOwner={owner}
      tag={tag}
      posts={postList.slice(0, PAGE_SIZE)}
      pinnedPosts={[]}
      featuredTags={featuredTagList}
      olderUrl={olderUrl}
      newerUrl={newerUrl}
    />,
  );
});

interface ProfilePageProps {
  readonly accountOwner: AccountOwner & { account: Account };
  readonly tag?: string;
  readonly posts: (Post & {
    account: Account;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    sharing:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
          quoteTarget:
            | (Post & {
                account: Account;
                media: Medium[];
                poll: (Poll & { options: PollOption[] }) | null;
                replyTarget: (Post & { account: Account }) | null;
                reactions: Reaction[];
              })
            | null;
          reactions: Reaction[];
        })
      | null;
    replyTarget: (Post & { account: Account }) | null;
    quoteTarget:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
          reactions: Reaction[];
        })
      | null;
    reactions: Reaction[];
  })[];
  readonly pinnedPosts: (Post & {
    account: Account;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    sharing:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
          quoteTarget:
            | (Post & {
                account: Account;
                media: Medium[];
                poll: (Poll & { options: PollOption[] }) | null;
                replyTarget: (Post & { account: Account }) | null;
                reactions: Reaction[];
              })
            | null;
          reactions: Reaction[];
        })
      | null;
    replyTarget: (Post & { account: Account }) | null;
    quoteTarget:
      | (Post & {
          account: Account;
          media: Medium[];
          poll: (Poll & { options: PollOption[] }) | null;
          replyTarget: (Post & { account: Account }) | null;
          reactions: Reaction[];
        })
      | null;
    reactions: Reaction[];
  })[];
  readonly featuredTags: FeaturedTag[];
  readonly atomUrl?: string;
  readonly olderUrl?: string;
  readonly newerUrl?: string;
}

function ProfilePage({
  accountOwner,
  tag,
  posts,
  pinnedPosts,
  featuredTags,
  atomUrl,
  olderUrl,
  newerUrl,
}: ProfilePageProps) {
  return (
    <Layout
      title={
        tag == null
          ? accountOwner.account.name
          : `#${tag} - ${accountOwner.account.name}`
      }
      url={
        tag == null
          ? (accountOwner.account.url ?? accountOwner.account.iri)
          : undefined
      }
      description={accountOwner.bio}
      imageUrl={accountOwner.account.avatarUrl}
      links={[
        ...(atomUrl == null
          ? []
          : [
              { rel: "alternate", type: "application/atom+xml", href: atomUrl },
            ]),
        {
          rel: "alternate",
          type: "application/activity+json",
          href: `/@${accountOwner.handle}`,
        },
      ]}
      themeColor={accountOwner.themeColor}
    >
      <main class="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
        <Profile accountOwner={accountOwner} />
        {tag != null && (
          <h2 class="mt-10 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Posts tagged{" "}
            <span class="text-brand-700 dark:text-brand-400">#{tag}</span>
          </h2>
        )}
        {featuredTags.length > 0 && (
          <div class="mt-6 flex flex-wrap items-center gap-2 text-sm">
            <span class="text-neutral-500 dark:text-neutral-400">
              Featured tags:
            </span>
            {featuredTags.map((tag) => (
              <a
                href={`/@${accountOwner.handle}/tagged/${encodeURIComponent(tag.name)}`}
                class="rounded-full border border-neutral-200 bg-white px-3 py-0.5 text-neutral-700 hover:border-brand-400 hover:text-brand-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-brand-600 dark:hover:text-brand-400"
              >
                #{tag.name}
              </a>
            ))}
          </div>
        )}
        <div class="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          {tag == null &&
            pinnedPosts.map((post) => <PostView post={post} pinned={true} />)}
          {posts.map((post) => (
            <PostView post={post} />
          ))}
        </div>
        {(newerUrl || olderUrl) && (
          <nav class="mt-8 flex items-center justify-between gap-4">
            <div>
              {newerUrl && (
                <a
                  href={newerUrl}
                  class="inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-brand-700 dark:text-neutral-400 dark:hover:text-brand-400"
                >
                  <span class="i-lucide-arrow-left" aria-hidden="true" />
                  Newer
                </a>
              )}
            </div>
            <div>
              {olderUrl && (
                <a
                  href={olderUrl}
                  class="inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-brand-700 dark:text-neutral-400 dark:hover:text-brand-400"
                >
                  Older
                  <span class="i-lucide-arrow-right" aria-hidden="true" />
                </a>
              )}
            </div>
          </nav>
        )}
      </main>
    </Layout>
  );
}

profile.get("/atom.xml", async (c) => {
  let handle = c.req.param("handle");
  if (handle == null) return c.notFound();
  if (handle.startsWith("@")) handle = handle.substring(1);
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.handle, handle),
    with: { account: true },
  });
  if (owner == null) return c.notFound();
  const postList = await db.query.posts.findMany({
    with: { account: true },
    where: and(
      eq(posts.accountId, owner.id),
      or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
    ),
    orderBy: desc(posts.published),
    limit: 100,
  });
  const canonicalUrl = new URL(c.req.url);
  canonicalUrl.search = "";
  const response = await c.html(
    <feed xmlns="http://www.w3.org/2005/Atom">
      <id>urn:uuid:{owner.id}</id>
      <title>{owner.account.name}</title>
      <link rel="self" type="application/atom+xml" href={canonicalUrl.href} />
      <link
        rel="alternate"
        type="text/html"
        href={owner.account.url ?? owner.account.iri}
      />
      <link
        rel="alternate"
        type="application/activity+json"
        href={owner.account.iri}
      />
      <author>
        <name>{owner.account.name}</name>
        <uri>{owner.account.url ?? owner.account.iri}</uri>
      </author>
      <updated>
        {(postList[0]?.updated ?? owner.account.updated).toISOString()}
      </updated>
      {postList.map((post) => {
        const title = xss(post.contentHtml ?? "", {
          allowCommentTag: false,
          whiteList: {},
          stripIgnoreTag: true,
          stripBlankChar: false,
        })
          .trimStart()
          .replace(/\r?\n.*$/, "");
        return (
          <entry>
            <id>urn:uuid:{post.id}</id>
            <title dangerouslySetInnerHTML={{ __html: title }} />
            <link
              rel="alternate"
              type="text/html"
              href={post.url ?? post.iri}
            />
            <link
              rel="alternate"
              type="application/activity+json"
              href={post.iri}
            />
            <author>
              <name>{post.account.name}</name>
              <uri>{post.account.url ?? post.account.iri}</uri>
            </author>
            <content type="html">{post.contentHtml}</content>
            {post.published && (
              <published>{post.published.toISOString()}</published>
            )}
            <updated>{post.updated.toISOString()}</updated>
          </entry>
        );
      })}
    </feed>,
  );
  response.headers.set("Content-Type", "application/atom+xml");
  return response;
});

export default profile;
