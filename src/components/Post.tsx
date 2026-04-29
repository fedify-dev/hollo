import { renderCustomEmojis } from "../custom-emoji";
import { stripQuoteInlineFallbacks } from "../html";
import type { PreviewCard } from "../previewcard";
import type {
  Account,
  Medium as DbMedium,
  Poll as DbPoll,
  Post as DbPost,
  PollOption,
  Reaction,
} from "../schema";

export interface PostProps {
  readonly post: DbPost & {
    account: Account;
    media: DbMedium[];
    poll: (DbPoll & { options: PollOption[] }) | null;
    sharing:
      | (DbPost & {
          account: Account;
          media: DbMedium[];
          poll: (DbPoll & { options: PollOption[] }) | null;
          replyTarget: (DbPost & { account: Account }) | null;
          quoteTarget:
            | (DbPost & {
                account: Account;
                media: DbMedium[];
                poll: (DbPoll & { options: PollOption[] }) | null;
                replyTarget: (DbPost & { account: Account }) | null;
                reactions: Reaction[];
              })
            | null;
          reactions: Reaction[];
        })
      | null;
    replyTarget: (DbPost & { account: Account }) | null;
    quoteTarget:
      | (DbPost & {
          account: Account;
          media: DbMedium[];
          poll: (DbPoll & { options: PollOption[] }) | null;
          replyTarget: (DbPost & { account: Account }) | null;
          reactions: Reaction[];
        })
      | null;
    reactions: Reaction[];
  };
  readonly shared?: Date;
  readonly pinned?: boolean;
  readonly quoted?: boolean;
  readonly featured?: boolean;
}

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

const numberFormatter = new Intl.NumberFormat("en-US");

export function Post({ post, shared, pinned, quoted, featured }: PostProps) {
  if (post.sharing != null)
    return (
      <Post
        post={{ ...post.sharing, sharing: null }}
        shared={post.published ?? undefined}
        featured={featured}
      />
    );
  const account = post.account;
  const authorNameHtml = renderCustomEmojis(account.name, account.emojis);
  const authorUrl = account.url ?? account.iri;
  const wrapperClass = quoted
    ? "rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/60"
    : featured
      ? "py-2"
      : "py-5";
  const avatarSize = quoted ? "size-9" : featured ? "size-12" : "size-11";
  const avatarPx = quoted ? 36 : featured ? 48 : 44;
  return (
    <article class={wrapperClass}>
      {pinned && (
        <p class="mb-2 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-brand-700 dark:text-brand-400">
          <span class="i-lucide-pin" aria-hidden="true" />
          Pinned
        </p>
      )}
      <header class="flex items-start gap-3">
        {account.avatarUrl && (
          <a href={authorUrl} class="shrink-0">
            <img
              src={account.avatarUrl}
              alt=""
              width={avatarPx}
              height={avatarPx}
              class={`${avatarSize} rounded-full object-cover`}
            />
          </a>
        )}
        <div class="min-w-0 flex-1">
          <div
            class={
              quoted
                ? "text-sm font-semibold text-neutral-900 dark:text-neutral-100"
                : featured
                  ? "text-lg font-semibold text-neutral-900 dark:text-neutral-100"
                  : "font-semibold text-neutral-900 dark:text-neutral-100"
            }
          >
            <a
              href={authorUrl}
              dangerouslySetInnerHTML={{ __html: authorNameHtml }}
              class="hover:underline"
            />
          </div>
          <div class="text-xs text-neutral-500 dark:text-neutral-400">
            <span class="select-all">{account.handle}</span>
            {post.replyTarget != null && (
              <>
                {" · "}
                <span>
                  Reply to{" "}
                  <a
                    href={post.replyTarget.url ?? post.replyTarget.iri}
                    class="hover:text-brand-700 dark:hover:text-brand-400"
                  >
                    {post.replyTarget.account.name}
                  </a>
                </span>
              </>
            )}
          </div>
        </div>
      </header>
      <div class="mt-3">
        {post.summary == null || post.summary.trim() === "" ? (
          <PostContent post={post} featured={featured} />
        ) : (
          <details class="group">
            <summary
              lang={post.language ?? undefined}
              class="cursor-pointer rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-700"
            >
              {post.summary}
            </summary>
            <div class="mt-3">
              <PostContent post={post} featured={featured} />
            </div>
          </details>
        )}
      </div>
      <footer class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        {shared != null && (
          <>
            <span class="inline-flex items-center gap-1">
              <span class="i-lucide-repeat-2" aria-hidden="true" />
              Shared on{" "}
              <time dateTime={shared.toISOString()}>
                {dateFormatter.format(shared)}
              </time>
            </span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <a
          href={post.url ?? post.iri}
          class="hover:text-brand-700 dark:hover:text-brand-400"
        >
          <time dateTime={(post.published ?? post.updated).toISOString()}>
            {dateFormatter.format(post.published ?? post.updated)}
          </time>
        </a>
        {post.likesCount != null && post.likesCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span class="inline-flex items-center gap-1">
              <span class="i-lucide-heart" aria-hidden="true" />
              {numberFormatter.format(post.likesCount)}
            </span>
          </>
        )}
        {post.sharesCount != null && post.sharesCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span class="inline-flex items-center gap-1">
              <span class="i-lucide-repeat-2" aria-hidden="true" />
              {numberFormatter.format(post.sharesCount)}
            </span>
          </>
        )}
        {post.reactions.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span class="inline-flex flex-wrap items-center gap-1">
              {Object.entries(groupByEmojis(post.reactions)).map(
                ([emoji, { src, count }]) =>
                  src == null ? (
                    <span title={`${emoji} × ${count}`}>{emoji}</span>
                  ) : (
                    <img
                      src={src}
                      alt={emoji}
                      title={`${emoji} × ${count}`}
                      class="inline h-4 align-text-bottom"
                    />
                  ),
              )}
            </span>
          </>
        )}
      </footer>
    </article>
  );
}

function groupByEmojis(
  reactions: Reaction[],
): Record<string, { src?: string; count: number }> {
  const result: Record<string, { src?: string; count: number }> = {};
  for (const reaction of reactions) {
    if (result[reaction.emoji] == null) {
      result[reaction.emoji] = {
        src: reaction.customEmoji ?? undefined,
        count: 1,
      };
    } else {
      result[reaction.emoji].count++;
    }
  }
  return result;
}

interface PostContentProps {
  readonly post: DbPost & {
    media: DbMedium[];
    poll: (DbPoll & { options: PollOption[] }) | null;
    quoteTarget:
      | (DbPost & {
          account: Account;
          media: DbMedium[];
          poll: (DbPoll & { options: PollOption[] }) | null;
          replyTarget: (DbPost & { account: Account }) | null;
          reactions: Reaction[];
        })
      | null;
  };
  readonly featured?: boolean;
}

function PostContent({ post, featured }: PostContentProps) {
  const displayContentHtml =
    post.quoteTarget == null
      ? post.contentHtml
      : stripQuoteInlineFallbacks(post.contentHtml);
  const contentHtml = renderCustomEmojis(displayContentHtml, post.emojis);
  return (
    <>
      {displayContentHtml && (
        <div
          class={
            featured
              ? "prose prose-base prose-neutral dark:prose-invert prose-a:text-brand-700 dark:prose-a:text-brand-400 max-w-none break-words"
              : "prose prose-sm prose-neutral dark:prose-invert prose-a:text-brand-700 dark:prose-a:text-brand-400 max-w-none break-words"
          }
          dangerouslySetInnerHTML={{ __html: contentHtml ?? "" }}
          lang={post.language ?? undefined}
        />
      )}
      {post.poll != null && <Poll poll={post.poll} />}
      {post.media.length > 0 && (
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          {post.media.map((medium) => (
            <figure class="m-0">
              <Medium medium={medium} />
              {medium.description && medium.description.trim() !== "" && (
                <figcaption class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  <details>
                    <summary class="cursor-pointer">ALT text</summary>
                    <p class="mt-1">{medium.description}</p>
                  </details>
                </figcaption>
              )}
            </figure>
          ))}
        </div>
      )}
      {post.previewCard != null && post.media.length === 0 && (
        <PreviewCardView card={post.previewCard} />
      )}
      {post.quoteTarget != null && (
        <div class="mt-3">
          <Post
            post={{ ...post.quoteTarget, sharing: null, quoteTarget: null }}
            quoted={true}
          />
        </div>
      )}
    </>
  );
}

interface PreviewCardViewProps {
  readonly card: PreviewCard;
}

function PreviewCardView({ card }: PreviewCardViewProps) {
  let host: string | null = null;
  try {
    host = new URL(card.url).hostname.replace(/^www\./, "");
  } catch {
    host = null;
  }
  const hasImage = card.image != null;
  return (
    <a
      href={card.url}
      target="_blank"
      rel="noopener nofollow"
      class="mt-3 flex overflow-hidden rounded-lg border border-neutral-200 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
    >
      {hasImage && (
        <div class="aspect-square w-28 shrink-0 bg-neutral-100 sm:w-36 dark:bg-neutral-900">
          <img
            src={card.image!.url}
            alt=""
            loading="lazy"
            class="size-full object-cover"
          />
        </div>
      )}
      <div class="min-w-0 flex-1 self-center p-3 sm:p-4">
        {host && (
          <p class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {host}
          </p>
        )}
        <h3 class="mt-0.5 line-clamp-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {card.title}
        </h3>
        {card.description && card.description.trim() !== "" && (
          <p class="mt-1 line-clamp-2 text-xs text-neutral-600 dark:text-neutral-400">
            {card.description}
          </p>
        )}
      </div>
    </a>
  );
}

interface PollProps {
  readonly poll: DbPoll & { options: PollOption[] };
}

function Poll({ poll }: PollProps) {
  const options = poll.options;
  options.sort((a, b) => (a.index < b.index ? -1 : 1));
  const totalVotes = options.reduce(
    (acc, option) => acc + option.votesCount,
    0,
  );
  return (
    <ul class="mt-3 space-y-2">
      {options.map((option) => {
        const percent =
          option.votesCount <= 0
            ? 0
            : Math.round((option.votesCount / totalVotes) * 100);
        return (
          <li class="relative overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <div
              class="absolute inset-y-0 left-0 bg-brand-100 dark:bg-brand-900/40"
              style={`width: ${percent}%`}
              aria-hidden="true"
            />
            <div class="relative flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span class="text-neutral-900 dark:text-neutral-100">
                {option.title}
              </span>
              <span class="text-neutral-500 tabular-nums dark:text-neutral-400">
                {numberFormatter.format(option.votesCount)} ({percent}%)
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

interface MediumProps {
  readonly medium: DbMedium;
}

function Medium({ medium }: MediumProps) {
  return (
    <a
      href={medium.url}
      class="block overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800"
    >
      {medium.thumbnailCleaned ? (
        <span class="flex aspect-video items-center justify-center bg-neutral-100 px-3 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          Thumbnail not available
        </span>
      ) : (
        <img
          key={medium.id}
          src={medium.thumbnailUrl}
          alt={medium.description ?? ""}
          width={medium.thumbnailWidth}
          height={medium.thumbnailHeight}
          class="block h-auto w-full object-cover"
        />
      )}
    </a>
  );
}
