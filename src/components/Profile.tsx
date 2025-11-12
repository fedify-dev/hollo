import { escape } from "es-toolkit";
import type { Account, AccountOwner } from "../schema";
import { renderCustomEmojis } from "../text";

export interface ProfileProps {
  accountOwner: AccountOwner & { account: Account };
}

export function Profile({ accountOwner }: ProfileProps) {
  const account = accountOwner.account;
  const nameHtml = renderCustomEmojis(escape(account.name), account.emojis);
  const bioHtml = renderCustomEmojis(account.bioHtml ?? "", account.emojis);
  const url = account.url ?? account.iri;
  return (
    <div>
      {account.coverUrl && (
        <img
          src={account.coverUrl}
          alt=""
          style="margin-bottom: 1em; width: 100%;"
        />
      )}
      <hgroup>
        {account.avatarUrl && (
          <img
            src={account.avatarUrl}
            alt={`${account.name}'s avatar`}
            width={72}
            height={72}
            style="float: left; margin-right: 1em;"
          />
        )}
        <h1>
          <a dangerouslySetInnerHTML={{ __html: nameHtml }} href={url} />
        </h1>
        <p>
          <span
            style="user-select: all;"
            data-tooltip="Use this handle to reach out to this account on your fediverse server!"
            data-placement="bottom"
          >
            {account.handle}
          </span>{" "}
          &middot; {`${account.followingCount} following `}
          &middot;{" "}
          {account.followersCount === 1
            ? "1 follower"
            : `${account.followersCount} followers`}
        </p>
      </hgroup>
      <div dangerouslySetInnerHTML={{ __html: bioHtml }} />
      {account.fieldHtmls && (
        <div class="overflow-auto">
          <table>
            <thead>
              <tr>
                {Object.keys(account.fieldHtmls).map((key) => (
                  <th>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {Object.values(account.fieldHtmls).map((value) => (
                  <td dangerouslySetInnerHTML={{ __html: value }} />
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
