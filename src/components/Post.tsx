import type {
  Account,
  Medium as DbMedium,
  Poll as DbPoll,
  Post as DbPost,
  PollOption,
  Reaction,
} from "../schema";
import { renderCustomEmojis } from "../text";

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
}

export function Post({ post, shared, pinned, quoted }: PostProps) {
  if (post.sharing != null)
    return (
      <Post
        post={{ ...post.sharing, sharing: null }}
        shared={post.published ?? undefined}
      />
    );
  const account = post.account;
  const authorNameHtml = renderCustomEmojis(account.name, account.emojis);
  const authorUrl = account.url ?? account.iri;
  const authorName = (
    <a dangerouslySetInnerHTML={{ __html: authorNameHtml }} href={authorUrl} />
  );
  return (
    <article
      style={
        pinned
          ? "border: 1px solid silver;"
          : quoted
            ? "border: calc(var(--pico-border-width)*4) solid var(--pico-background-color);"
            : ""
      }
    >
      <header>
        <hgroup>
          {account.avatarUrl && (
            <img
              src={account.avatarUrl}
              alt={`${account.name}'s avatar`}
              width={quoted ? 40 : 48}
              height={quoted ? 40 : 48}
              style="float: left; margin-right: .5em;"
            />
          )}
          {quoted ? (
            <h6 style="font-size: smaller;">{authorName}</h6>
          ) : (
            <h5>{authorName}</h5>
          )}
          <p>
            <small style="user-select: all;">{account.handle}</small>
            {post.replyTarget != null && (
              <>
                {" "}
                &middot;{" "}
                <small>
                  Reply to{" "}
                  <a href={post.replyTarget.url ?? post.replyTarget.iri}>
                    {post.replyTarget.account.name}'s post
                  </a>
                </small>{" "}
              </>
            )}
          </p>
        </hgroup>
      </header>
      {post.summary == null || post.summary.trim() === "" ? (
        <PostContent post={post} />
      ) : (
        <details>
          <summary lang={post.language ?? undefined}>{post.summary}</summary>
          <PostContent post={post} />
        </details>
      )}
      <footer>
        <p>
          {shared != null && (
            <small>
              Shared at{" "}
              <time dateTime={shared.toISOString()}>
                {shared.toLocaleString("en", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>{" "}
              &middot;{" "}
            </small>
          )}
          <a href={post.url ?? post.iri}>
            <small>
              Published at{" "}
              <time dateTime={(post.published ?? post.updated).toISOString()}>
                {(post.published ?? post.updated).toLocaleString("en", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </small>
          </a>
          {post.likesCount != null && post.likesCount > 0 && (
            <small>
              {" "}
              &middot;{" "}
              {`${post.likesCount} ${
                post.likesCount === null || post.likesCount < 2
                  ? "like"
                  : "likes"
              }`}
            </small>
          )}
          {post.reactions.length > 0 && (
            <small>
              {" "}
              &middot;{" "}
              {Object.entries(groupByEmojis(post.reactions)).map(
                ([emoji, { src, count }]) => (
                  <>
                    {src == null ? (
                      <span title={`${emoji} × ${count}`}>{emoji}</span>
                    ) : (
                      <img
                        src={src}
                        alt={emoji}
                        title={`${emoji} × ${count}`}
                        style="vertical-align: text-bottom; height: 22px;"
                      />
                    )}{" "}
                  </>
                ),
              )}
            </small>
          )}
          {post.sharesCount != null && post.sharesCount > 0 && (
            <small>
              {" "}
              &middot;{" "}
              {`${post.sharesCount} ${
                post.sharesCount === null || post.sharesCount < 2
                  ? "share"
                  : "shares"
              }`}
            </small>
          )}
          {pinned && <small> &middot; Pinned</small>}
        </p>
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
}

function PostContent({ post }: PostContentProps) {
  const contentHtml = renderCustomEmojis(post.contentHtml, post.emojis);
  return (
    <>
      {post.contentHtml && (
        <div
          dangerouslySetInnerHTML={{ __html: contentHtml ?? "" }}
          lang={post.language ?? undefined}
        />
      )}
      {post.poll != null && <Poll poll={post.poll} />}
      {post.media.map((medium) => (
        <div>
          <Medium medium={medium} />
          {medium.description && medium.description.trim() !== "" && (
            <>
              <hr />
              <details>
                <summary>ALT text details</summary>
                {medium.description}
              </details>
            </>
          )}
        </div>
      ))}
      {post.quoteTarget != null && (
        <Post
          post={{ ...post.quoteTarget, sharing: null, quoteTarget: null }}
          quoted={true}
        />
      )}
    </>
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
    <table>
      <thead>
        <tr>
          <th>Option</th>
          <th>Voters</th>
        </tr>
      </thead>
      <tbody>
        {options.map((option) => {
          const percent =
            option.votesCount <= 0
              ? 0
              : Math.round((option.votesCount / totalVotes) * 100);
          return (
            <tr key={option.index}>
              <td>{option.title}</td>
              <td>
                <span
                  style={`display: block; width: ${percent}%; white-space: nowrap; border: 1px solid white; border-radius: 5px; padding: 3px 5px; background-color: black; color: white; text-shadow: 0 0 2px black;`}
                >
                  {option.votesCount} ({percent}%)
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface MediumProps {
  readonly medium: DbMedium;
}

function Medium({ medium }: MediumProps) {
  return (
    <a href={medium.url}>
      <img
        key={medium.id}
        src={medium.thumbnailUrl}
        alt={medium.description ?? ""}
        width={medium.thumbnailWidth}
        height={medium.thumbnailHeight}
      />
    </a>
  );
}
