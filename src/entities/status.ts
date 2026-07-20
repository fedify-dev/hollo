import { sql } from "drizzle-orm";

import { stripQuoteInlineFallbacks } from "../html";
import { orderMedia } from "../media-order";
import { proxyUrl } from "../media-proxy";
import type { PreviewCard } from "../previewcard";
import {
  type Account,
  type AccountOwner,
  type Application,
  type Bookmark,
  type Follow,
  type Like,
  type Medium,
  type Mention,
  type PinnedPost,
  type Poll,
  type PollOption,
  type PollVote,
  type Post,
  type QuoteApprovalPolicy,
  type QuoteState,
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
  owner?: Pick<AccountOwner, "id"> | null;
};

type StatusApplication = Pick<Application, "name" | "website">;
type StatusReplyTarget = Pick<Post, "accountId">;
type StatusPoll = Pick<Poll, "id" | "expires" | "multiple" | "votersCount"> & {
  options: Pick<PollOption, "index" | "title" | "votesCount">[];
  votes: Pick<PollVote, "accountId" | "optionIndex">[];
};
type StatusMention = Mention & {
  account: Pick<Account, "handle" | "url" | "iri"> & {
    owner?: Pick<AccountOwner, "id"> | null;
    successor?: Account | null;
  };
};
type StatusReaction = Reaction & {
  account: Pick<Account, "id" | "handle">;
};
type StatusLike = Pick<Like, "accountId">;
type StatusShare = Pick<Post, "accountId">;
type StatusBookmark = Pick<Bookmark, "accountOwnerId">;
type StatusPin = Pick<PinnedPost, "accountId">;

export type SerializablePost = Post & {
  account: StatusAccount;
  application: StatusApplication | null;
  replyTarget: StatusReplyTarget | null;
  sharing?: SerializablePost | null;
  quoteTarget?: SerializablePost | null;
  media: Medium[];
  poll: StatusPoll | null;
  mentions: StatusMention[];
  likes: StatusLike[];
  reactions: StatusReaction[];
  shares: StatusShare[];
  bookmarks: StatusBookmark[];
  pin: StatusPin | null;
};

function getEffectiveQuoteState(
  post: Post & { quoteTarget?: Post | null },
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
  targetIsLocal: boolean,
) {
  const isPrivateOrDirect =
    post.visibility === "direct" || post.visibility === "private";
  const effectivePolicy = isPrivateOrDirect ? "nobody" : (policy ?? "public");
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
            // Same-instance accounts are always auto-approved regardless
            // of the target's stated policy (see validateQuoteTarget), but
            // private/direct posts remain off-limits to other accounts.
            (targetIsLocal && !isPrivateOrDirect) ||
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
        ? { RAW: () => sql`false` }
        : {
            followerId: { eq: ownerId },
            approved: { isNotNull: true as const },
          },
  };
}

function accountIdWhere(ownerId: Uuid | undefined | null) {
  return ownerId == null
    ? { RAW: () => sql`false` }
    : { accountId: { eq: ownerId } };
}

function accountOwnerIdWhere(ownerId: Uuid | undefined | null) {
  return ownerId == null
    ? { RAW: () => sql`false` }
    : { accountOwnerId: { eq: ownerId } };
}

function getPollRelations(ownerId: Uuid | undefined | null) {
  return {
    with: {
      options: { orderBy: { index: "asc" } },
      votes: {
        where: accountIdWhere(ownerId),
      },
    },
  } as const;
}

function getTimelinePollRelations(ownerId: Uuid | undefined | null) {
  return {
    columns: {
      id: true,
      expires: true,
      multiple: true,
      votersCount: true,
    },
    with: {
      options: {
        columns: { index: true, title: true, votesCount: true },
        orderBy: { index: "asc" },
      },
      votes: {
        columns: { accountId: true, optionIndex: true },
        where: accountIdWhere(ownerId),
      },
    },
  } as const;
}

function getTimelinePostRelationsBase(ownerId: Uuid | undefined | null) {
  return {
    account: {
      with: {
        successor: true,
        followers: getViewerFollowerRelation(ownerId),
        owner: { columns: { id: true } },
      },
    },
    application: {
      columns: { name: true, website: true },
    },
    replyTarget: {
      columns: { accountId: true },
    },
    media: true,
    poll: getTimelinePollRelations(ownerId),
    mentions: {
      with: {
        account: {
          columns: { handle: true, url: true, iri: true },
          with: { owner: { columns: { id: true } } },
        },
      },
    },
    likes: {
      columns: { accountId: true },
      where: accountIdWhere(ownerId),
    },
    reactions: {
      with: {
        account: {
          columns: { id: true, handle: true },
        },
      },
    },
    shares: {
      columns: { accountId: true },
      where: accountIdWhere(ownerId),
    },
    bookmarks: {
      columns: { accountOwnerId: true },
      where: accountOwnerIdWhere(ownerId),
    },
    pin: {
      columns: { accountId: true },
    },
  } as const;
}

function getTimelineNestedPostRelations(ownerId: Uuid | undefined | null) {
  return {
    ...getTimelinePostRelationsBase(ownerId),
    quoteTarget: {
      with: getTimelinePostRelationsBase(ownerId),
    },
  } as const;
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
            owner: { columns: { id: true } },
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
                owner: { columns: { id: true } },
              },
            },
            application: true,
            replyTarget: true,
            media: true,
            poll: getPollRelations(ownerId),
            mentions: {
              with: { account: { with: { owner: true, successor: true } } },
            },
            likes: {
              where: accountIdWhere(ownerId),
            },
            reactions: { with: { account: { with: { successor: true } } } },
            shares: {
              where: accountIdWhere(ownerId),
            },
            bookmarks: {
              where: accountOwnerIdWhere(ownerId),
            },
            pin: true,
          },
        },
        media: true,
        poll: getPollRelations(ownerId),
        mentions: {
          with: { account: { with: { owner: true, successor: true } } },
        },
        likes: {
          where: accountIdWhere(ownerId),
        },
        reactions: { with: { account: { with: { successor: true } } } },
        shares: {
          where: accountIdWhere(ownerId),
        },
        bookmarks: {
          where: accountOwnerIdWhere(ownerId),
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
            owner: { columns: { id: true } },
          },
        },
        application: true,
        replyTarget: true,
        media: true,
        poll: getPollRelations(ownerId),
        mentions: {
          with: { account: { with: { owner: true, successor: true } } },
        },
        likes: {
          where: accountIdWhere(ownerId),
        },
        reactions: { with: { account: { with: { successor: true } } } },
        shares: {
          where: accountIdWhere(ownerId),
        },
        bookmarks: {
          where: accountOwnerIdWhere(ownerId),
        },
        pin: true,
      },
    },
    media: true,
    poll: getPollRelations(ownerId),
    mentions: { with: { account: { with: { owner: true, successor: true } } } },
    likes: {
      where: accountIdWhere(ownerId),
    },
    reactions: { with: { account: { with: { successor: true } } } },
    shares: {
      where: accountIdWhere(ownerId),
    },
    bookmarks: {
      where: accountOwnerIdWhere(ownerId),
    },
    pin: true,
  } as const;
}

export function getTimelinePostRelations(ownerId: Uuid | undefined | null) {
  return {
    ...getTimelinePostRelationsBase(ownerId),
    sharing: {
      with: getTimelineNestedPostRelations(ownerId),
    },
    quoteTarget: {
      with: getTimelinePostRelationsBase(ownerId),
    },
  } as const;
}

export function serializePost(
  post: SerializablePost,
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
      post.account.owner != null,
    ),
    application:
      post.application == null
        ? null
        : {
            name: post.application.name,
            website: post.application.website,
          },
    account: serializeAccount(post.account, baseUrl),
    media_attachments: orderMedia(post.media).map((medium) =>
      serializeMedium(medium, baseUrl),
    ),
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
      post.previewCard == null
        ? null
        : serializePreviewCard(post.previewCard, baseUrl),
    emojis: serializeEmojis(post.emojis, baseUrl),
    emoji_reactions: serializeReactions(
      post.reactions,
      currentAccountOwner,
      baseUrl,
    ),
    poll:
      post.poll == null ? null : serializePoll(post.poll, currentAccountOwner),
    filtered: null,
  };
}

export function serializePreviewCard(
  card: PreviewCard,
  baseUrl: URL | string,
): Record<string, unknown> {
  // Compute the proxied image URL up front: if proxyUrl rejects the image
  // (non-http(s) scheme), the dimensions should not be reported either.
  const imageUrl =
    card.image == null ? null : proxyUrl(card.image.url, baseUrl);
  const width =
    imageUrl == null || card.image?.width == null
      ? 0
      : typeof card.image.width === "string"
        ? Number.parseInt(card.image.width, 10)
        : card.image.width;
  const height =
    imageUrl == null || card.image?.height == null
      ? 0
      : typeof card.image.height === "string"
        ? Number.parseInt(card.image.height, 10)
        : card.image.height;
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
    width,
    height,
    image: imageUrl,
    embed_url: "",
    blurhash: null,
  };
}
