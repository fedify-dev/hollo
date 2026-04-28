import { escape } from "es-toolkit";

import { renderCustomEmojis } from "../custom-emoji";
import type { Account, AccountOwner } from "../schema";

export interface ProfileProps {
  accountOwner: AccountOwner & { account: Account };
}

const numberFormatter = new Intl.NumberFormat("en-US");

export function Profile({ accountOwner }: ProfileProps) {
  const account = accountOwner.account;
  const nameHtml = renderCustomEmojis(escape(account.name), account.emojis);
  const bioHtml = renderCustomEmojis(account.bioHtml ?? "", account.emojis);
  const url = account.url ?? account.iri;
  const fieldEntries = account.fieldHtmls
    ? Object.entries(account.fieldHtmls)
    : [];
  return (
    <header class="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div class="relative h-44 overflow-hidden rounded-t-xl bg-gradient-to-br from-brand-100 to-brand-300 dark:from-brand-900 dark:to-brand-700 sm:h-56">
        {account.coverUrl && (
          <img
            src={account.coverUrl}
            alt=""
            class="absolute inset-0 size-full object-cover"
          />
        )}
      </div>
      <div class="px-5 pb-6 sm:px-7">
        <div class="relative -mt-12 flex items-end justify-between gap-4">
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt={`${account.name}'s avatar`}
              width={96}
              height={96}
              class="size-24 rounded-full border-4 border-white bg-white object-cover dark:border-neutral-900 dark:bg-neutral-900"
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
            <span>
              <strong class="font-semibold text-neutral-900 dark:text-neutral-100">
                {numberFormatter.format(account.followingCount ?? 0)}
              </strong>{" "}
              following
            </span>
            <span>
              <strong class="font-semibold text-neutral-900 dark:text-neutral-100">
                {numberFormatter.format(account.followersCount ?? 0)}
              </strong>{" "}
              {account.followersCount === 1 ? "follower" : "followers"}
            </span>
          </p>
          {bioHtml && (
            <div
              class="prose prose-sm prose-neutral dark:prose-invert mt-4 max-w-none"
              dangerouslySetInnerHTML={{ __html: bioHtml }}
            />
          )}
          {fieldEntries.length > 0 && (
            <dl class="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {fieldEntries.map(([key, value]) => (
                <div class="border-t border-neutral-200 pt-3 dark:border-neutral-800">
                  <dt class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    {key}
                  </dt>
                  <dd
                    class="mt-1 text-sm text-neutral-800 dark:text-neutral-200 [&_a]:text-brand-700 [&_a]:underline-offset-2 hover:[&_a]:underline dark:[&_a]:text-brand-400"
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
