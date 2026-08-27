import { escape } from "es-toolkit";

import { renderCustomEmojis } from "../custom-emoji";
import { proxyUrl } from "../media-proxy";
import type { Account, AccountOwner } from "../schema";

export type ProfileAccount = Account & { successor: Account | null };

export interface ProfileProps {
  accountOwner: AccountOwner & { account: ProfileAccount };
  baseUrl: URL | string;
}

const numberFormatter = new Intl.NumberFormat("en-US");

export function Profile({ accountOwner, baseUrl }: ProfileProps) {
  const account = accountOwner.account;
  const successor = account.successor;
  const nameHtml = renderCustomEmojis(
    escape(account.name),
    account.emojis,
    baseUrl,
  );
  const successorNameHtml =
    successor == null
      ? ""
      : renderCustomEmojis(escape(successor.name), successor.emojis, baseUrl);
  const bioHtml = renderCustomEmojis(
    account.bioHtml ?? "",
    account.emojis,
    baseUrl,
  );
  const url = account.url ?? account.iri;
  const successorUrl =
    successor == null ? undefined : (successor.url ?? successor.iri);
  const avatar = proxyUrl(account.avatarUrl, baseUrl);
  const successorAvatar =
    successor == null ? undefined : proxyUrl(successor.avatarUrl, baseUrl);
  const cover = proxyUrl(account.coverUrl, baseUrl);
  const fieldEntries = account.fieldHtmls
    ? Object.entries(account.fieldHtmls)
    : [];
  const moved = successor != null;
  const coverClass = moved
    ? "relative h-44 overflow-hidden bg-gradient-to-br from-neutral-100 to-neutral-300 dark:from-neutral-900 dark:to-neutral-800 sm:h-56"
    : "relative h-44 overflow-hidden rounded-t-xl bg-gradient-to-br from-brand-100 to-brand-300 dark:from-brand-900 dark:to-brand-700 sm:h-56";
  const mutedImageClass = moved ? " grayscale opacity-60" : "";
  const metricStrongClass = moved
    ? "font-semibold text-neutral-700 dark:text-neutral-300"
    : "font-semibold text-brand-700 dark:text-brand-400";
  const metricLinkClass = moved
    ? "transition-colors hover:text-neutral-900 dark:hover:text-neutral-100"
    : "transition-colors hover:text-brand-700 dark:hover:text-brand-400";
  const proseClass = moved
    ? "prose prose-sm prose-neutral dark:prose-invert prose-a:text-neutral-700 dark:prose-a:text-neutral-300 mt-4 max-w-none"
    : "prose prose-sm prose-neutral dark:prose-invert prose-a:text-brand-700 dark:prose-a:text-brand-400 mt-4 max-w-none";
  const fieldLinkClass = moved
    ? "mt-1 text-sm text-neutral-800 dark:text-neutral-200 [&_a]:text-neutral-700 [&_a]:underline-offset-2 hover:[&_a]:underline dark:[&_a]:text-neutral-300"
    : "mt-1 text-sm text-neutral-800 dark:text-neutral-200 [&_a]:text-brand-700 [&_a]:underline-offset-2 hover:[&_a]:underline dark:[&_a]:text-brand-400";
  return (
    <header class="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {successor && successorUrl && (
        <div class="rounded-t-xl border-b border-neutral-200 bg-neutral-50 px-5 py-4 dark:border-neutral-800 dark:bg-neutral-900/80 sm:px-7">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            This account has moved to:
          </p>
          <div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <a
              href={successorUrl}
              class="min-w-0 inline-flex items-center gap-3 text-neutral-900 hover:underline dark:text-neutral-100"
            >
              {successorAvatar ? (
                <img
                  src={successorAvatar}
                  alt=""
                  width={40}
                  height={40}
                  class="size-10 rounded-full object-cover"
                />
              ) : (
                <span class="block size-10 rounded-full bg-neutral-200 dark:bg-neutral-800" />
              )}
              <span class="min-w-0">
                <span
                  class="block truncate font-semibold"
                  dangerouslySetInnerHTML={{ __html: successorNameHtml }}
                />
                <span class="block truncate text-sm text-neutral-500 dark:text-neutral-400">
                  {successor.handle}
                </span>
              </span>
            </a>
            <a
              href={successorUrl}
              class="inline-flex items-center justify-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-neutral-300"
            >
              View profile
              <span class="i-lucide-arrow-right" aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
      <div class={coverClass}>
        {cover && (
          <img
            src={cover}
            alt=""
            class={`absolute inset-0 size-full object-cover${mutedImageClass}`}
          />
        )}
      </div>
      <div class="px-5 pb-6 sm:px-7">
        <div class="relative -mt-12 flex items-end justify-between gap-4">
          {avatar ? (
            <img
              src={avatar}
              alt={`${account.name}'s avatar`}
              width={96}
              height={96}
              class={`size-24 rounded-full border-4 border-white bg-white object-cover dark:border-neutral-900 dark:bg-neutral-900${mutedImageClass}`}
            />
          ) : (
            <div class="size-24 rounded-full border-4 border-white bg-neutral-200 dark:border-neutral-900 dark:bg-neutral-800" />
          )}
        </div>
        <div class="mt-4">
          <h1 class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            <a
              href={url}
              dangerouslySetInnerHTML={{ __html: nameHtml }}
              aria-label={account.name}
              lang={accountOwner.language}
              class="hover:underline"
            />
          </h1>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
            <span
              class="select-all text-neutral-500 dark:text-neutral-400"
              title="Use this handle to reach out to this account on the fediverse."
            >
              {account.handle}
            </span>
          </p>
          <p class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400">
            {accountOwner.followingListPublic ? (
              <a
                href={`/@${accountOwner.handle}/following`}
                class={metricLinkClass}
              >
                <strong class={metricStrongClass}>
                  {numberFormatter.format(account.followingCount ?? 0)}
                </strong>{" "}
                following
              </a>
            ) : (
              <span>
                <strong class={metricStrongClass}>
                  {numberFormatter.format(account.followingCount ?? 0)}
                </strong>{" "}
                following
              </span>
            )}
            <a
              href={`/@${accountOwner.handle}/followers`}
              class={metricLinkClass}
            >
              <strong class={metricStrongClass}>
                {numberFormatter.format(account.followersCount ?? 0)}
              </strong>{" "}
              {account.followersCount === 1 ? "follower" : "followers"}
            </a>
          </p>
          {bioHtml && (
            <div
              class={proseClass}
              dangerouslySetInnerHTML={{ __html: bioHtml }}
              lang={accountOwner.language}
            />
          )}
          {fieldEntries.length > 0 && (
            <dl class="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {fieldEntries.map(([key, value]) => (
                <div
                  lang={accountOwner.language}
                  class="border-t border-neutral-200 pt-3 dark:border-neutral-800"
                >
                  <dt class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    {key}
                  </dt>
                  <dd
                    class={fieldLinkClass}
                    dangerouslySetInnerHTML={{ __html: value }}
                  />
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </header>
  );
}
