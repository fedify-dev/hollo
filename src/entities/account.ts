import type { Account, AccountOwner, Block, Follow, Mute } from "../schema";
import type { Uuid } from "../uuid";
import { sanitizeHtml } from "../xss";
import { serializeEmojis } from "./emoji";

export function serializeAccount(
  account: Account & { successor: Account | null },
  baseUrl: URL | string,
): Record<string, unknown> {
  baseUrl = new URL(baseUrl);
  const username = account.handle.replaceAll(/(?:^@)|(?:@[^@]+$)/g, "");
  const defaultAvatarUrl = new URL(
    "/image/avatars/original/missing.png",
    baseUrl,
  ).href;
  const defaultHeaderUrl = new URL(
    "/image/headers/original/missing.png",
    baseUrl,
  ).href;
  let acct = account.handle.replace(/^@/, "");
  if (acct.endsWith(`@${baseUrl.host}`)) {
    acct = acct.replace(/@[^@]+$/, "");
  }
  return {
    id: account.id,
    username,
    acct,
    display_name: account.name,
    locked: account.protected,
    bot: account.type === "Application" || account.type === "Service",
    created_at: account.published ?? account.updated,
    note: sanitizeHtml(account.bioHtml ?? ""),
    url: account.url ?? account.iri,
    avatar: account.avatarUrl ?? defaultAvatarUrl,
    avatar_static: account.avatarUrl ?? defaultAvatarUrl,
    header: account.coverUrl ?? defaultHeaderUrl,
    header_static: account.coverUrl ?? defaultHeaderUrl,
    followers_count: account.followersCount,
    following_count: account.followingCount,
    statuses_count: account.postsCount,
    moved:
      account.successor == null
        ? null
        : serializeAccount({ ...account.successor, successor: null }, baseUrl),
    last_status_at: null,
    emojis: serializeEmojis(account.emojis),
    fields: Object.entries(account.fieldHtmls).map(([name, value]) => ({
      name,
      value,
      verified_at: null,
    })),
  };
}

export function serializeAccountOwner(
  accountOwner: AccountOwner & {
    account: Account & { successor: Account | null };
  },
  baseUrl: URL | string,
): Record<string, unknown> {
  return {
    ...serializeAccount(accountOwner.account, baseUrl),
    discoverable: accountOwner.discoverable,
    source: accountOwner && {
      note: accountOwner.bio,
      privacy: accountOwner.visibility,
      sensitive: accountOwner.account.sensitive,
      language: accountOwner.language,
      follow_requests_count: 0,
      fields: Object.entries(accountOwner.fields).map(([name, value]) => ({
        name,
        value,
        verified_at: null,
      })),
    },
  };
}

export function serializeRelationship(
  account: Account & {
    followers: Follow[];
    following: Follow[];
    mutedBy: Mute[];
    blocks: Block[];
    blockedBy: Block[];
  },
  currentAccountOwner: { id: Uuid },
): Record<string, unknown> {
  const following = account.followers.find(
    (f) => f.followerId === currentAccountOwner.id,
  );
  const followedBy = account.following.find(
    (f) => f.followingId === currentAccountOwner.id,
  );
  const now = Date.now();
  const muting = account.mutedBy.find((m) => {
    if (m.accountId !== currentAccountOwner.id) return false;
    if (m.duration == null) return true;
    let d = +new Date(`1970-01-01T${m.duration.replace(/^-/, "")}Z`);
    if (m.duration.startsWith("-")) d = -d;
    return d <= 0 || now < m.created.getTime() + d;
  });
  return {
    id: account.id,
    following: following?.approved != null,
    showing_reblogs: following?.shares === true,
    notifying: following?.notify === true,
    languages: following == null ? null : following.languages,
    followed_by: followedBy?.approved != null,
    blocking: account.blockedBy.some(
      (b) => b.accountId === currentAccountOwner.id,
    ),
    blocked_by: account.blocks.some(
      (b) => b.blockedAccountId === currentAccountOwner.id,
    ),
    muting: muting != null,
    muting_notifications: muting?.notifications === true,
    requested: following != null && following.approved == null,
    requested_by: followedBy != null && followedBy.approved == null,
    domain_blocking: false, // TODO
    endorsed: false, // TODO
    note: "", // TODO
  };
}
