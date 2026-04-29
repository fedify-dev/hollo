import { and, eq, isNotNull, sql } from "drizzle-orm";

import { stripQuoteInlineFallbacks } from "../html";
import type { PreviewCard } from "../previewcard";
import {
  type Account,
  type AccountOwner,
  type Application,
  type Bookmark,
  bookmarks,
  type Follow,
  follows,
  type Like,
  likes,
  type Medium,
  type Mention,
  type PinnedPost,
  type Poll,
  type PollOption,
  type PollVote,
  type Post,
  type QuoteApprovalPolicy,
  type QuoteState,
  pollOptions,
  pollVotes,
  posts,
  type Reaction,
} from "../schema";
import type { Uuid } from "../uuid";
import { sanitizeHtml } from "../xss";
import { serializeAccount } from "./account";
import { serializeEmojis, serializeReactions } from "./emoji";
import { serializeMedium } from "./medium";
import { serializePoll } from "./poll";

type StatusAccount = Account & {
  successor: Account | null;
  followers?: Follow[];
};

function getEffectiveQuoteState(
  post: Post & { quoteTarget: Post | null },
): QuoteState | "deleted" | null {
  const state =
    post.quoteState ?? (post.quoteTargetId == null ? null : "accepted");
  if (state === "accepted" && post.quoteTarget == null) return "deleted";
  return state;
}

function serializeQuoteApproval(
  policy: QuoteApprovalPolicy | null,
  currentAccountOwner: { id: string } | undefined | null,
  post: Pick<Post, "accountId" | "visibility">,
  viewerIsApprovedFollower: boolean,
) {
  const effectivePolicy =
    post.visibility === "direct" || post.visibility === "private"
      ? "nobody"
      : (policy ?? "public");
  const automatic =
    effectivePolicy === "public"
      ? ["public"]
      : effectivePolicy === "followers"
        ? ["followers"]
        : [];
  return {
    automatic,
    manual: [],
    ...(currentAccountOwner == null
      ? {}
      : {
          current_user:
            currentAccountOwner.id === post.accountId ||
            effectivePolicy === "public" ||
            (effectivePolicy === "followers" && viewerIsApprovedFollower)
              ? "automatic"
              : "denied",
        }),
  };
}

function getViewerFollowerRelation(ownerId: Uuid | undefined | null) {
  return {
    where:
      ownerId == null
        ? sql`false`
        : and(eq(follows.followerId, ownerId), isNotNull(follows.approved)),
  };
}

export function getPostRelations(ownerId: Uuid | undefined | null) {
  return {
    account: {
      with: {
        owner: true,
        successor: true,
        followers: getViewerFollowerRelation(ownerId),
      },
    },
    application: true,
    replyTarget: true,
    sharing: {
      with: {
        account: {
          with: {
            successor: true,
            followers: getViewerFollowerRelation(ownerId),
          },
        },
        application: true,
        replyTarget: true,
        quoteTarget: {
          with: {
            account: {
              with: {
                successor: true,
                followers: getViewerFollowerRelation(ownerId),
              },
            },
            application: true,
            replyTarget: true,
            media: true,
            poll: {
              with: {
                options: { orderBy: pollOptions.index },
                votes: {
                  where:
                    ownerId == null
                      ? sql`false`
                      : eq(pollVotes.accountId, ownerId),
                },
              },
            },
            mentions: {
              with: { account: { with: { owner: true, successor: true } } },
            },
            likes: {
              where:
                ownerId == null ? sql`false` : eq(likes.accountId, ownerId),
            },
            reactions: { with: { account: { with: { successor: true } } } },
            shares: {
              where:
                ownerId == null ? sql`false` : eq(posts.accountId, ownerId),
            },
            bookmarks: {
              where:
                ownerId == null
                  ? sql`false`
                  : eq(bookmarks.accountOwnerId, ownerId),
            },
            pin: true,
          },
        },
        media: true,
        poll: {
          with: {
            options: { orderBy: pollOptions.index },
            votes: {
              where:
                ownerId == null ? sql`false` : eq(pollVotes.accountId, ownerId),
            },
          },
        },
        mentions: {
          with: { account: { with: { owner: true, successor: true } } },
        },
        likes: {
          where: ownerId == null ? sql`false` : eq(likes.accountId, ownerId),
        },
        reactions: { with: { account: { with: { successor: true } } } },
        shares: {
          where: ownerId == null ? sql`false` : eq(posts.accountId, ownerId),
        },
        bookmarks: {
          where:
            ownerId == null
              ? sql`false`
              : eq(bookmarks.accountOwnerId, ownerId),
        },
        pin: true,
      },
    },
    quoteTarget: {
      with: {
        account: {
          with: {
            successor: true,
            followers: getViewerFollowerRelation(ownerId),
          },
        },
        application: true,
        replyTarget: true,
        media: true,
        poll: {
          with: {
            options: { orderBy: pollOptions.index },
            votes: {
              where:
                ownerId == null ? sql`false` : eq(pollVotes.accountId, ownerId),
            },
          },
        },
        mentions: {
          with: { account: { with: { owner: true, successor: true } } },
        },
        likes: {
          where: ownerId == null ? sql`false` : eq(likes.accountId, ownerId),
        },
        reactions: { with: { account: { with: { successor: true } } } },
        shares: {
          where: ownerId == null ? sql`false` : eq(posts.accountId, ownerId),
        },
        bookmarks: {
          where:
            ownerId == null
              ? sql`false`
              : eq(bookmarks.accountOwnerId, ownerId),
        },
        pin: true,
      },
    },
    media: true,
    poll: {
      with: {
        options: { orderBy: pollOptions.index },
        votes: {
          where:
            ownerId == null ? sql`false` : eq(pollVotes.accountId, ownerId),
        },
      },
    },
    mentions: { with: { account: { with: { owner: true, successor: true } } } },
    likes: {
      where: ownerId == null ? sql`false` : eq(likes.accountId, ownerId),
    },
    reactions: { with: { account: { with: { successor: true } } } },
    shares: {
      where: ownerId == null ? sql`false` : eq(posts.accountId, ownerId),
    },
    bookmarks: {
      where:
        ownerId == null ? sql`false` : eq(bookmarks.accountOwnerId, ownerId),
    },
    pin: true,
    replies: true,
  } as const;
}

export function serializePost(
  post: Post & {
    account: StatusAccount;
    application: Application | null;
    replyTarget: Post | null;
    sharing:
      | (Post & {
          account: StatusAccount;
          application: Application | null;
          replyTarget: Post | null;
          quoteTarget:
            | (Post & {
                account: StatusAccount;
                application: Application | null;
                replyTarget: Post | null;
                media: Medium[];
                poll:
                  | (Poll & { options: PollOption[]; votes: PollVote[] })
                  | null;
                mentions: (Mention & {
                  account: Account & {
                    owner: AccountOwner | null;
                    successor: Account | null;
                  };
                })[];
                likes: Like[];
                reactions: (Reaction & {
                  account: Account & { successor: Account | null };
                })[];
                shares: Post[];
                bookmarks: Bookmark[];
                pin: PinnedPost | null;
              })
            | null;
          media: Medium[];
          poll: (Poll & { options: PollOption[]; votes: PollVote[] }) | null;
          mentions: (Mention & {
            account: Account & {
              owner: AccountOwner | null;
              successor: Account | null;
            };
          })[];
          likes: Like[];
          reactions: (Reaction & {
            account: Account & { successor: Account | null };
          })[];
          shares: Post[];
          bookmarks: Bookmark[];
          pin: PinnedPost | null;
        })
      | null;
    quoteTarget:
      | (Post & {
          account: StatusAccount;
          application: Application | null;
          replyTarget: Post | null;
          media: Medium[];
          poll: (Poll & { options: PollOption[]; votes: PollVote[] }) | null;
          mentions: (Mention & {
            account: Account & {
              owner: AccountOwner | null;
              successor: Account | null;
            };
          })[];
          likes: Like[];
          reactions: (Reaction & {
            account: Account & { successor: Account | null };
          })[];
          shares: Post[];
          bookmarks: Bookmark[];
          pin: PinnedPost | null;
        })
      | null;
    media: Medium[];
    poll: (Poll & { options: PollOption[]; votes: PollVote[] }) | null;
    mentions: (Mention & {
      account: Account & {
        owner: AccountOwner | null;
        successor: Account | null;
      };
    })[];
    likes: Like[];
    reactions: (Reaction & {
      account: Account & { successor: Account | null };
    })[];
    shares: Post[];
    bookmarks: Bookmark[];
    pin: PinnedPost | null;
  },
  currentAccountOwner: { id: string } | undefined | null,
  baseUrl: URL | string,
  // oxlint-disable-next-line typescript/no-explicit-any
): Record<string, any> {
  const quoteState = getEffectiveQuoteState(post);
  const quoteIsDisplayable =
    quoteState === "accepted" && post.quoteTarget != null;
  const viewerIsApprovedFollower =
    currentAccountOwner != null &&
    post.account.followers?.some(
      (follow) => follow.followerId === currentAccountOwner.id,
    ) === true;
  return {
    id: post.id,
    created_at: post.published ?? post.updated,
    in_reply_to_id: post.replyTargetId,
    in_reply_to_account_id: post.replyTarget?.accountId,
    sensitive: post.sensitive,
    spoiler_text: post.summary ?? "",
    visibility: post.visibility,
    language: post.language,
    uri: post.iri,
    url: post.url ?? post.iri,
    replies_count: post.repliesCount ?? 0,
    reblogs_count: post.sharesCount ?? 0,
    favourites_count: post.likesCount ?? 0,
    quotes_count: post.quotesCount ?? 0,
    favourited:
      currentAccountOwner == null
        ? false
        : post.likes.some((like) => like.accountId === currentAccountOwner.id),
    reblogged:
      currentAccountOwner == null
        ? false
        : post.shares.some(
            (share) => share.accountId === currentAccountOwner.id,
          ),
    muted: false, // TODO
    bookmarked:
      currentAccountOwner == null
        ? false
        : post.bookmarks.some(
            (bookmark) => bookmark.accountOwnerId === currentAccountOwner.id,
          ),
    pinned:
      currentAccountOwner == null
        ? false
        : post.pin != null && post.pin.accountId === currentAccountOwner.id,
    content: sanitizeHtml(
      !quoteIsDisplayable
        ? (post.contentHtml ?? "")
        : stripQuoteInlineFallbacks(post.contentHtml ?? ""),
    ),
    reblog:
      post.sharing == null
        ? null
        : serializePost(
            { ...post.sharing, sharing: null },
            currentAccountOwner,
            baseUrl,
          ),
    quote_id: post.quoteTargetId,
    quote:
      quoteState == null
        ? null
        : {
            state: quoteState,
            quoted_status: quoteIsDisplayable
              ? serializePost(
                  { ...post.quoteTarget!, quoteTarget: null, sharing: null },
                  currentAccountOwner,
                  baseUrl,
                )
              : null,
          },
    quote_approval: serializeQuoteApproval(
      post.quoteApprovalPolicy,
      currentAccountOwner,
      post,
      viewerIsApprovedFollower,
    ),
    application:
      post.application == null
        ? null
        : {
            name: post.application.name,
            website: post.application.website,
          },
    account: serializeAccount(post.account, baseUrl),
    media_attachments: post.media.map(serializeMedium),
    mentions: post.mentions.map((mention) => ({
      id: mention.accountId,
      username: mention.account.handle.replaceAll(/(?:^@)|(?:@[^@]+$)/g, ""),
      url: mention.account.url ?? mention.account.iri,
      acct:
        mention.account.owner == null
          ? mention.account.handle.replace(/^@/, "")
          : mention.account.handle.replaceAll(/(?:^@)|(?:@[^@]+$)/g, ""),
    })),
    tags: Object.entries(post.tags).map(([name, url]) => ({
      name: name.toLowerCase().replace(/^#/, ""),
      url,
    })),
    card:
      post.previewCard == null ? null : serializePreviewCard(post.previewCard),
    emojis: serializeEmojis(post.emojis),
    emoji_reactions: serializeReactions(post.reactions, currentAccountOwner),
    poll:
      post.poll == null ? null : serializePoll(post.poll, currentAccountOwner),
    filtered: null,
  };
}

export function serializePreviewCard(
  card: PreviewCard,
): Record<string, unknown> {
  return {
    url: card.url,
    title: card.title,
    description: card.description ?? "",
    type: "link",
    author_name: "",
    author_url: "",
    provider_name: "",
    provider_url: "",
    html: "",
    width:
      card.image?.width == null
        ? 0
        : typeof card.image.width === "string"
          ? Number.parseInt(card.image.width, 10)
          : card.image.width,
    height:
      card.image?.height == null
        ? 0
        : typeof card.image.height === "string"
          ? Number.parseInt(card.image.height, 10)
          : card.image.height,
    image: card.image == null ? null : card.image.url,
    embed_url: "",
    blurhash: null,
  };
}
