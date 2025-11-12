import { escape } from "es-toolkit";
import type { Account, AccountOwner } from "../schema";
import { renderCustomEmojis } from "../text";
import { sanitizeHtml } from "../xss";

export interface AccountListProps {
  accountOwners: (AccountOwner & { account: Account })[];
}

export function AccountList({ accountOwners }: AccountListProps) {
  return (
    <>
      {accountOwners.map((account) => (
        <AccountItem accountOwner={account} />
      ))}
    </>
  );
}

interface AccountItemProps {
  accountOwner: AccountOwner & { account: Account };
}

function AccountItem({ accountOwner: { account } }: AccountItemProps) {
  const nameHtml = renderCustomEmojis(escape(account.name), account.emojis);
  const bioHtml = renderCustomEmojis(
    sanitizeHtml(account.bioHtml ?? ""),
    account.emojis,
  );
  const href = account.url ?? account.iri;
  return (
    <article>
      <header>
        <hgroup>
          <h2>
            <a dangerouslySetInnerHTML={{ __html: nameHtml }} href={href} />
          </h2>
          <p style="user-select: all;">{account.handle}</p>
        </hgroup>
      </header>
      <div dangerouslySetInnerHTML={{ __html: bioHtml }} />
      <p>
        {account.published ? (
          <small>
            Created at{" "}
            <time dateTime={account.published.toISOString()}>
              {account.published.toLocaleDateString()}
            </time>
            .
          </small>
        ) : (
          <small>
            Fetched at{" "}
            <time dateTime={account.updated.toISOString()}>
              {account.updated.toLocaleDateString()}
            </time>
            .
          </small>
        )}
      </p>
      <footer>
        <form
          className="grid"
          action={`/accounts/${account.id}/delete`}
          method="post"
          onsubmit="return confirm('Are you sure you want to delete this account?')"
        >
          <div role="group">
            <a
              href={`/accounts/${account.id}`}
              role="button"
              style="display: block;"
            >
              Edit
            </a>
            <a
              href={`/accounts/${account.id}/migrate`}
              role="button"
              className="contrast"
              style="display: block;"
            >
              Migrate from/to
            </a>
            <button type="submit" className="secondary">
              Delete
            </button>
          </div>
        </form>
      </footer>
    </article>
  );
}
