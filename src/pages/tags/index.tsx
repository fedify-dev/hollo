import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { Layout } from "../../components/Layout.tsx";
import { Post as PostView } from "../../components/Post.tsx";
import { db } from "../../db.ts";
import {
  type Account,
  accountOwners,
  type Medium,
  type Poll,
  type PollOption,
  type Post,
  posts,
  type Reaction,
} from "../../schema.ts";

const tags = new Hono().basePath("/:tag");

tags.get(async (c) => {
  const tag = c.req.param("tag");
  const handle = c.req.query("handle");
  const hashtag = `#${tag.toLowerCase()}`;
  const postList = await db.query.posts.findMany({
    where: and(
      sql`${posts.tags} ? ${hashtag}`,
      eq(posts.visibility, "public"),
      handle == null
        ? undefined
        : eq(
            posts.accountId,
            db
              .select({ id: accountOwners.id })
              .from(accountOwners)
              .where(eq(accountOwners.handle, handle)),
          ),
    ),
    orderBy: desc(posts.id),
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
  return c.html(<TagPage tag={tag} posts={postList} />);
});

interface TagPageProps {
  readonly tag: string;
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
}

function TagPage({ tag, posts }: TagPageProps) {
  return (
    <Layout title={`#${tag}`}>
      <main class="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
        <header class="mb-6">
          <p class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            Hashtag
          </p>
          <h1 class="mt-1 text-3xl font-bold text-neutral-900 dark:text-neutral-100">
            <span class="text-brand-700 dark:text-brand-400">#</span>
            {tag}
          </h1>
          <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {posts.length === 0
              ? "No posts found for this hashtag yet."
              : `${posts.length.toLocaleString("en-US")} ${
                  posts.length === 1 ? "post" : "posts"
                } tagged with this hashtag.`}
          </p>
        </header>
        <div class="divide-y divide-neutral-200 dark:divide-neutral-800">
          {posts.map((post) => (
            <PostView post={post} />
          ))}
        </div>
      </main>
    </Layout>
  );
}

export default tags;
