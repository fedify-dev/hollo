import { escape } from "es-toolkit";

import { renderCustomEmojis } from "../custom-emoji";
import type { Account, AccountOwner } from "../schema";
import { sanitizeHtml } from "../xss";

export interface AccountListProps {
  accountOwners: (AccountOwner & { account: Account })[];
}

export function AccountList({ accountOwners }: AccountListProps) {
  return (
    <ul class="space-y-4">
      {accountOwners.map((account) => (
        <li>
          <AccountItem accountOwner={account} />
        </li>
      ))}
    </ul>
  );
}

interface AccountItemProps {
  accountOwner: AccountOwner & { account: Account };
}

function AccountItem({ accountOwner: { account, ...rest } }: AccountItemProps) {
  const nameHtml = renderCustomEmojis(escape(account.name), account.emojis);
  const bioHtml = renderCustomEmojis(
    sanitizeHtml(account.bioHtml ?? ""),
    account.emojis,
  );
  const href = account.url ?? account.iri;
  const ownerId = rest.id;
  return (
    <article class="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div class="flex items-start gap-4">
        {account.avatarUrl && (
          <a href={href} class="shrink-0">
            <img
              src={account.avatarUrl}
              alt=""
              width={56}
              height={56}
              class="size-14 rounded-full object-cover"
            />
          </a>
        )}
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            <a
              href={href}
              dangerouslySetInnerHTML={{ __html: nameHtml }}
              class="hover:underline"
            />
          </h2>
          <p class="mt-0.5 select-all text-sm text-neutral-500 dark:text-neutral-400">
            {account.handle}
          </p>
          {bioHtml && (
            <div
              class="prose prose-sm prose-neutral dark:prose-invert mt-3 max-w-none"
              dangerouslySetInnerHTML={{ __html: bioHtml }}
            />
          )}
          <p class="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            {account.published ? (
              <>
                Created{" "}
                <time dateTime={account.published.toISOString()}>
                  {account.published.toLocaleDateString()}
                </time>
              </>
            ) : (
              <>
                Fetched{" "}
                <time dateTime={account.updated.toISOString()}>
                  {account.updated.toLocaleDateString()}
                </time>
              </>
            )}
          </p>
        </div>
      </div>
      <footer class="mt-5 flex flex-wrap gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <a
          href={`/accounts/${ownerId}`}
          class="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
        >
          <span class="i-lucide-pencil" aria-hidden="true" />
          Edit
        </a>
        <a
          href={`/accounts/${ownerId}/migrate`}
          class="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span class="i-lucide-arrow-right-left" aria-hidden="true" />
          Migrate
        </a>
        <form
          action={`/accounts/${ownerId}/delete`}
          method="post"
          onsubmit="return confirm('Are you sure you want to delete this account?')"
          class="ms-auto m-0"
        >
          <button
            type="submit"
            class="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 transition-colors hover:bg-red-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            <span class="i-lucide-trash-2" aria-hidden="true" />
            Delete
          </button>
        </form>
      </footer>
    </article>
  );
}
