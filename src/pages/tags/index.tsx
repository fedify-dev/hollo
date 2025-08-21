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
      <h1>#{tag}</h1>
      {posts.map((post) => (
        <PostView post={post} />
      ))}
    </Layout>
  );
}

export default tags;
