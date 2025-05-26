import { escape } from "es-toolkit";
import { Layout } from "../../components/Layout";
import type { Account, AccountOwner, Application, Scope } from "../../schema";
import { renderCustomEmojis } from "../../text";

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
      <hgroup>
        <h1>Authorize {props.application.name}</h1>
        <p>Do you want to authorize this application to access your account?</p>
      </hgroup>
      <p>It allows the application to:</p>
      <ul id="scopes">
        {props.scopes.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
      <form action="/oauth/authorize" method="post">
        <p>Choose an account to authorize:</p>
        {props.accountOwners.map((accountOwner, i) => {
          const accountName = renderCustomEmojis(
            escape(accountOwner.account.name),
            accountOwner.account.emojis,
          );
          return (
            <label>
              <input
                type="radio"
                name="account_id"
                value={accountOwner.id}
                checked={i === 0}
              />
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: xss protected */}
              <strong dangerouslySetInnerHTML={{ __html: accountName }} />
              <p style="margin-left: 1.75em; margin-top: 0.25em;">
                <small>{accountOwner.account.handle}</small>
              </p>
            </label>
          );
        })}
        <input
          type="hidden"
          name="application_id"
          value={props.application.id}
        />
        <input type="hidden" name="redirect_uri" value={props.redirectUri} />
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
        <div role="group">
          {props.redirectUri !== "urn:ietf:wg:oauth:2.0:oob" && (
            <button
              type="submit"
              class="secondary"
              name="decision"
              value="deny"
            >
              Deny
            </button>
          )}
          <button type="submit" name="decision" value="allow">
            Allow
          </button>
        </div>
      </form>
    </Layout>
  );
}
