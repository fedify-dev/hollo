import { escape } from "es-toolkit";

import { AuthCard } from "../../components/AuthCard";
import { Layout } from "../../components/Layout";
import { renderCustomEmojis } from "../../custom-emoji";
import type { Account, AccountOwner, Application, Scope } from "../../schema";

interface AuthorizationPageProps {
  accountOwners: (AccountOwner & { account: Account })[];
  application: Application;
  redirectUri: string;
  scopes: Scope[];
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export function AuthorizationPage(props: AuthorizationPageProps) {
  return (
    <Layout title={`Hollo: Authorize ${props.application.name}`}>
      <AuthCard
        title={`Authorize ${props.application.name}`}
        subtitle="Do you want to authorize this application to access your account?"
      >
        <div class="space-y-6">
          <div class="rounded-md border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
            <p class="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              The application can:
            </p>
            <ul id="scopes" class="mt-2 flex flex-wrap gap-1.5">
              {props.scopes.map((scope) => (
                <li key={scope}>
                  <code class="inline-block rounded bg-white px-2 py-0.5 font-mono text-xs text-brand-700 ring-1 ring-neutral-200 dark:bg-neutral-950 dark:text-brand-400 dark:ring-neutral-800">
                    {scope}
                  </code>
                </li>
              ))}
            </ul>
          </div>
          <form action="/oauth/authorize" method="post" class="space-y-5">
            <fieldset class="space-y-2">
              <legend class="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                Choose an account to authorize:
              </legend>
              {props.accountOwners.map((accountOwner, i) => {
                const accountName = renderCustomEmojis(
                  escape(accountOwner.account.name),
                  accountOwner.account.emojis,
                );
                const inputId = `oauth-account-${accountOwner.id}`;
                return (
                  <label
                    for={inputId}
                    class="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-200 bg-white p-3 transition-colors hover:border-brand-400 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-brand-600 dark:has-[:checked]:bg-brand-950/40"
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="account_id"
                      value={accountOwner.id}
                      checked={i === 0}
                      class="mt-1 size-4 border-neutral-300 text-brand-600 focus:ring-brand-200 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-brand-900"
                    />
                    <span class="min-w-0 flex-1">
                      <span
                        class="block font-semibold text-neutral-900 dark:text-neutral-100"
                        dangerouslySetInnerHTML={{ __html: accountName }}
                      />
                      <span class="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                        {accountOwner.account.handle}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <input
              type="hidden"
              name="application_id"
              value={props.application.id}
            />
            <input
              type="hidden"
              name="redirect_uri"
              value={props.redirectUri}
            />
            <input type="hidden" name="scopes" value={props.scopes.join(" ")} />
            {props.state != null && (
              <input type="hidden" name="state" value={props.state} />
            )}
            {typeof props.codeChallenge === "string" && (
              <>
                <input
                  type="hidden"
                  name="code_challenge"
                  value={props.codeChallenge}
                />
                <input
                  type="hidden"
                  name="code_challenge_method"
                  value={props.codeChallengeMethod}
                />
              </>
            )}
            <div class="flex gap-2">
              {props.redirectUri !== "urn:ietf:wg:oauth:2.0:oob" && (
                <button
                  type="submit"
                  name="decision"
                  value="deny"
                  class="flex-1 rounded-md border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  Deny
                </button>
              )}
              <button
                type="submit"
                name="decision"
                value="allow"
                class="flex-1 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
              >
                Allow
              </button>
            </div>
          </form>
        </div>
      </AuthCard>
    </Layout>
  );
}
