import { Hono } from "hono";

import { Layout } from "../../components/Layout.tsx";
import { type PostForView, Post as PostView } from "../../components/Post.tsx";
import db from "../../db.ts";
import { type AccountOwner } from "../../schema.ts";
import { isUuid } from "../../uuid.ts";
import { postViewRelations } from "./postRelations.ts";
import { summarizePostForTitle } from "./summary.ts";

const profilePost = new Hono();

profilePost.get<"/:handle{@[^/]+}/:id{[-a-f0-9]+}">(async (c) => {
  let handle = c.req.param("handle");
  const postId = c.req.param("id");
  if (!isUuid(postId)) return c.notFound();
  if (handle.startsWith("@")) handle = handle.substring(1);
  const accountOwner = await db.query.accountOwners.findFirst({
    where: { handle: { eq: handle } },
  });
  if (accountOwner == null) return c.notFound();
  const post = await db.query.posts.findFirst({
    where: {
      RAW: (posts, { and, eq, or }) =>
        and(
          eq(posts.accountId, accountOwner.id),
          eq(posts.id, postId),
          or(eq(posts.visibility, "public"), eq(posts.visibility, "unlisted")),
        )!,
    },
    with: {
      ...postViewRelations,
      replies: {
        where: { visibility: { in: ["public", "unlisted"] } },
        orderBy: (posts, { desc }) => [desc(posts.published)],
        limit: 20,
        with: postViewRelations,
      },
    },
  });
  if (post == null) return c.notFound();
  return c.html(
    <PostPage post={post} accountOwner={accountOwner} baseUrl={c.req.url} />,
  );
});

interface PostPageProps {
  readonly accountOwner: AccountOwner;
  readonly post: PostForView & { replies: PostForView[] };
  readonly baseUrl: URL | string;
}

function PostPage({ post, accountOwner, baseUrl }: PostPageProps) {
  const summary = summarizePostForTitle(post);
  return (
    <Layout
      title={`${summary} — ${post.account.name}`}
      shortTitle={summary}
      description={post.summary || post.content}
      imageUrl={post.account.avatarUrl}
      url={post.url ?? post.iri}
      links={[
        { rel: "alternate", type: "application/activity+json", href: post.iri },
      ]}
      themeColor={accountOwner.themeColor}
    >
      <main class="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
        <PostView
          post={post}
          featured={true}
          canonical={true}
          baseUrl={baseUrl}
        />
        {post.replies.length > 0 && (
          <section class="mt-8">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {post.replies.length === 1
                ? "1 reply"
                : `${post.replies.length} replies`}
            </h2>
            <div class="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
              {post.replies.map((reply) => (
                <PostView post={reply} baseUrl={baseUrl} />
              ))}
            </div>
          </section>
        )}
      </main>
    </Layout>
  );
}

export default profilePost;
