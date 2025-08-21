import {
  type Actor,
  Delete,
  exportJwk,
  generateCryptoKeyPair,
  getActorHandle,
  isActor,
  Move,
  type Object,
  PUBLIC_COLLECTION,
  type Recipient,
  Update,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { PromisePool } from "@supercharge/promise-pool";
import { createObjectCsvStringifier } from "csv-writer-portable";
import { and, count, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import neatCsv from "neat-csv";
import { AccountForm } from "../components/AccountForm.tsx";
import { AccountList } from "../components/AccountList.tsx";
import { DashboardLayout } from "../components/DashboardLayout.tsx";
import {
  NewAccountPage,
  type NewAccountPageProps,
} from "../components/NewAccountPage.tsx";
import db from "../db.ts";
import federation from "../federation";
import {
  blockAccount,
  followAccount,
  persistAccount,
  persistAccountPosts,
  REMOTE_ACTOR_FETCH_POSTS,
  unfollowAccount,
} from "../federation/account.ts";
import { isPost, persistPost } from "../federation/post.ts";
import { loginRequired } from "../login.ts";
import {
  type Account,
  type AccountOwner,
  accountOwners,
  accounts as accountsTable,
  blocks,
  bookmarks,
  follows,
  instances,
  listMembers,
  lists,
  mutes,
  type Post,
  type PostVisibility,
  type ThemeColor,
} from "../schema.ts";
import { extractCustomEmojis, formatText } from "../text.ts";
import { isUuid, type Uuid } from "../uuid.ts";

const HOLLO_OFFICIAL_ACCOUNT = "@hollo@hollo.social";

const logger = getLogger(["hollo", "pages", "accounts"]);

const accounts = new Hono();

accounts.use(loginRequired);

accounts.get("/", async (c) => {
  const owners = await db.query.accountOwners.findMany({
    with: { account: true },
  });
  return c.html(<AccountListPage accountOwners={owners} />);
});

accounts.post("/", async (c) => {
  const form = await c.req.formData();
  const username = form.get("username")?.toString()?.trim();
  const name = form.get("name")?.toString()?.trim();
  const bio = form.get("bio")?.toString()?.trim();
  const protected_ = form.get("protected") != null;
  const discoverable = form.get("discoverable") != null;
  const language = form.get("language")?.toString()?.trim();
  const visibility = form
    .get("visibility")
    ?.toString()
    ?.trim() as PostVisibility;
  const themeColor = form.get("themeColor")?.toString()?.trim() as ThemeColor;
  const news = form.get("news") != null;
  if (username == null || username === "" || name == null || name === "") {
    return c.html(
      <NewAccountPage
        values={{
          username,
          name,
          bio,
          protected: protected_,
          discoverable,
          language,
          visibility,
          themeColor,
          news,
        }}
        errors={{
          username:
            username == null || username === ""
              ? "Username is required."
              : undefined,
          name:
            name == null || name === ""
              ? "Display name is required."
              : undefined,
        }}
        officialAccount={HOLLO_OFFICIAL_ACCOUNT}
      />,
      400,
    );
  }
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const bioResult = await formatText(db, bio ?? "", fedCtx);
  const nameEmojis = await extractCustomEmojis(db, name);
  const emojis = { ...nameEmojis, ...bioResult.emojis };
  const [account, owner] = await db.transaction(async (tx) => {
    await tx
      .insert(instances)
      .values({
        host: fedCtx.host,
        software: "hollo",
        softwareVersion: null,
      })
      .onConflictDoNothing();
    const account = await tx
      .insert(accountsTable)
      .values({
        id: crypto.randomUUID(),
        iri: fedCtx.getActorUri(username).href,
        instanceHost: fedCtx.host,
        type: "Person",
        name,
        emojis,
        handle: `@${username}@${fedCtx.host}`,
        bioHtml: bioResult.html,
        url: fedCtx.getActorUri(username).href,
        protected: protected_,
        inboxUrl: fedCtx.getInboxUri(username).href,
        followersUrl: fedCtx.getFollowersUri(username).href,
        sharedInboxUrl: fedCtx.getInboxUri().href,
        featuredUrl: fedCtx.getFeaturedUri(username).href,
        published: new Date(),
      })
      .returning();
    const rsaKeyPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
    const ed25519KeyPair = await generateCryptoKeyPair("Ed25519");
    const owner = await tx
      .insert(accountOwners)
      .values({
        id: account[0].id,
        handle: username,
        rsaPrivateKeyJwk: await exportJwk(rsaKeyPair.privateKey),
        rsaPublicKeyJwk: await exportJwk(rsaKeyPair.publicKey),
        ed25519PrivateKeyJwk: await exportJwk(ed25519KeyPair.privateKey),
        ed25519PublicKeyJwk: await exportJwk(ed25519KeyPair.publicKey),
        bio: bio ?? "",
        language: language ?? "en",
        visibility: visibility ?? "public",
        themeColor,
        discoverable,
      })
      .returning();
    return [account[0], owner[0]];
  });
  const owners = await db.query.accountOwners.findMany({
    with: { account: true },
  });
  if (news) {
    const actor = await fedCtx.lookupObject(HOLLO_OFFICIAL_ACCOUNT);
    if (isActor(actor)) {
      await db.transaction(async (tx) => {
        const following = await persistAccount(tx, actor, c.req.url, fedCtx);
        if (following != null) {
          await followAccount(tx, fedCtx, { ...account, owner }, following);
          await persistAccountPosts(
            tx,
            { ...account, owner },
            REMOTE_ACTOR_FETCH_POSTS,
            c.req.url,
            {
              ...fedCtx,
              suppressError: true,
            },
          );
        }
      });
    }
  }
  return c.html(<AccountListPage accountOwners={owners} />);
});

interface AccountListPageProps {
  accountOwners: (AccountOwner & { account: Account })[];
}

function AccountListPage({ accountOwners }: AccountListPageProps) {
  return (
    <DashboardLayout title="Hollo: Accounts" selectedMenu="accounts">
      <hgroup>
        <h1>Accounts</h1>
        <p>
          You can have more than one account. Each account has its own handle,
          settings, and data, and you can switch between them at any time.
        </p>
      </hgroup>
      <AccountList accountOwners={accountOwners} />
      <a role="button" href="/accounts/new">
        Create a new account
      </a>
    </DashboardLayout>
  );
}

accounts.get("/new", (c) => {
  return c.html(
    <NewAccountPage
      values={{ language: "en", themeColor: "azure", news: true }}
      officialAccount={HOLLO_OFFICIAL_ACCOUNT}
    />,
  );
});

accounts.get("/:id", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const news = await db.query.follows.findFirst({
    where: and(
      eq(
        follows.followingId,
        db
          .select({ id: accountsTable.id })
          .from(accountsTable)
          .where(eq(accountsTable.handle, HOLLO_OFFICIAL_ACCOUNT)),
      ),
      eq(follows.followerId, accountOwner.id),
    ),
  });
  return c.html(
    <AccountPage
      accountOwner={accountOwner}
      news={news != null}
      officialAccount={HOLLO_OFFICIAL_ACCOUNT}
    />,
  );
});

interface AccountPageProps extends NewAccountPageProps {
  accountOwner: AccountOwner & { account: Account };
  news: boolean;
}

function AccountPage(props: AccountPageProps) {
  const username = `@${props.accountOwner.handle}`;
  return (
    <DashboardLayout
      title={`Hollo: Edit ${username}`}
      selectedMenu="accounts"
      themeColor={props.accountOwner.themeColor}
    >
      <hgroup>
        <h1>Edit {username}</h1>
        <p>You can edit your account by filling out the form below.</p>
      </hgroup>
      <AccountForm
        action={`/accounts/${props.accountOwner.account.id}`}
        readOnly={{ username: true }}
        values={{
          username: username.replace(/^@/, ""),
          name: props.values?.name ?? props.accountOwner.account.name,
          bio: props.values?.bio ?? props.accountOwner.bio ?? undefined,
          protected:
            props.values?.protected ?? props.accountOwner.account.protected,
          discoverable:
            props.values?.discoverable ?? props.accountOwner.discoverable,
          language: props.values?.language ?? props.accountOwner.language,
          visibility: props.values?.visibility ?? props.accountOwner.visibility,
          themeColor: props.values?.themeColor ?? props.accountOwner.themeColor,
          news: props.values?.news ?? props.news,
        }}
        errors={props.errors}
        officialAccount={HOLLO_OFFICIAL_ACCOUNT}
        submitLabel="Save changes"
      />
    </DashboardLayout>
  );
}

accounts.post("/:id", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const form = await c.req.formData();
  const name = form.get("name")?.toString()?.trim();
  const bio = form.get("bio")?.toString()?.trim();
  const protected_ = form.get("protected") != null;
  const discoverable = form.get("discoverable") != null;
  const language = form.get("language")?.toString()?.trim();
  const visibility = form
    .get("visibility")
    ?.toString()
    ?.trim() as PostVisibility;
  const themeColor = form.get("themeColor")?.toString()?.trim() as ThemeColor;
  const news = form.get("news") != null;
  if (name == null || name === "") {
    return c.html(
      <AccountPage
        accountOwner={accountOwner}
        news={news}
        values={{
          name,
          bio,
          protected: protected_,
          language,
          visibility,
          themeColor,
          news,
        }}
        errors={{
          name: name == null || name === "" ? "Display name is required." : "",
        }}
        officialAccount={HOLLO_OFFICIAL_ACCOUNT}
      />,
      400,
    );
  }
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const fmtOpts = {
    url: fedCtx.url,
    contextLoader: fedCtx.contextLoader,
    documentLoader: await fedCtx.getDocumentLoader({
      username: accountOwner.handle,
    }),
  };
  const bioResult = await formatText(db, bio ?? "", fmtOpts);
  const nameEmojis = await extractCustomEmojis(db, name);
  const emojis = { ...nameEmojis, ...bioResult.emojis };
  await db.transaction(async (tx) => {
    await tx
      .update(accountsTable)
      .set({
        name,
        emojis,
        bioHtml: bioResult.html,
        protected: protected_,
      })
      .where(eq(accountsTable.id, accountId));
    await tx
      .update(accountOwners)
      .set({ bio, language, visibility, themeColor, discoverable })
      .where(eq(accountOwners.id, accountId));
  });
  await fedCtx.sendActivity(
    { username: accountOwner.handle },
    "followers",
    new Update({
      actor: fedCtx.getActorUri(accountOwner.handle),
      object: await fedCtx.getActor(accountOwner.handle),
    }),
    { preferSharedInbox: true, excludeBaseUris: [fedCtx.url] },
  );
  const account = { ...accountOwner.account, owner: accountOwner };
  const newsActor = await fedCtx.lookupObject(HOLLO_OFFICIAL_ACCOUNT);
  if (isActor(newsActor)) {
    const newsAccount = await persistAccount(db, newsActor, c.req.url, fedCtx);
    if (newsAccount != null) {
      if (news) {
        await followAccount(db, fedCtx, account, newsAccount);
        await persistAccountPosts(
          db,
          newsAccount,
          REMOTE_ACTOR_FETCH_POSTS,
          c.req.url,
          {
            ...fedCtx,
            suppressError: true,
          },
        );
      } else await unfollowAccount(db, fedCtx, account, newsAccount);
    }
  }
  return c.redirect("/accounts");
});

accounts.post("/:id/delete", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
  });
  if (accountOwner == null) return c.notFound();
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const activity = new Delete({
    actor: fedCtx.getActorUri(accountOwner.handle),
    to: PUBLIC_COLLECTION,
    object: await fedCtx.getActor(accountOwner.handle),
  });
  await fedCtx.sendActivity(
    { username: accountOwner.handle },
    "followers",
    activity,
    { preferSharedInbox: true, excludeBaseUris: [fedCtx.url] },
  );
  const following = await db.query.follows.findMany({
    with: { following: true },
    where: eq(follows.followerId, accountId),
  });
  await fedCtx.sendActivity(
    { username: accountOwner.handle },
    following.map(
      (f) =>
        ({
          id: new URL(f.following.iri),
          inboxId: new URL(f.following.inboxUrl),
          endpoints:
            f.following.sharedInboxUrl == null
              ? null
              : { sharedInbox: new URL(f.following.sharedInboxUrl) },
        }) satisfies Recipient,
    ),
    activity,
    { preferSharedInbox: true, excludeBaseUris: [fedCtx.url] },
  );
  await db.transaction(async (tx) => {
    await tx.delete(accountOwners).where(eq(accountOwners.id, accountId));
    await tx.delete(accountsTable).where(eq(accountsTable.id, accountId));
  });
  return c.redirect("/accounts");
});

accounts.get("/:id/migrate", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: { with: { successor: true } } },
  });
  if (accountOwner == null) return c.notFound();
  const username = `@${accountOwner.handle}`;
  const aliases = await Promise.all(
    uniq(accountOwner.account.aliases).map(async (alias) => {
      let handle: Awaited<ReturnType<typeof getActorHandle>> | null;
      try {
        handle = await getActorHandle(new URL(alias));
      } catch (e) {
        if (e instanceof TypeError) {
          handle = null;
        } else {
          throw e;
        }
      }
      return { iri: alias, handle };
    }),
  );
  const [{ followsCount }] = await db
    .select({ followsCount: count() })
    .from(follows)
    .where(eq(follows.followerId, accountOwner.id));
  const [{ listsCount }] = await db
    .select({ listsCount: count() })
    .from(listMembers)
    .innerJoin(lists, eq(listMembers.listId, lists.id))
    .where(eq(lists.accountOwnerId, accountOwner.id));
  const [{ mutesCount }] = await db
    .select({ mutesCount: count() })
    .from(mutes)
    .where(eq(mutes.accountId, accountOwner.id));
  const [{ blocksCount }] = await db
    .select({ blocksCount: count() })
    .from(blocks)
    .where(eq(blocks.accountId, accountOwner.id));
  const [{ bookmarksCount }] = await db
    .select({ bookmarksCount: count() })
    .from(bookmarks)
    .where(eq(bookmarks.accountOwnerId, accountOwner.id));
  const aliasesError = c.req.query("error");
  const aliasesHandle = c.req.query("handle");
  const importDataResult = c.req.query("import-data-result");
  return c.html(
    <DashboardLayout
      title={`Hollo: Migrate ${username} from/to`}
      selectedMenu="accounts"
    >
      <hgroup>
        <h1>Migrate {username} from/to</h1>
        <p>
          You can migrate your account from one instance to another by filling
          out the form below.
        </p>
      </hgroup>

      <article>
        <header>
          <hgroup>
            <h2>Aliases</h2>
            <p>
              Configure aliases for your account. This purposes to migrate your
              old account to <tt>{accountOwner.account.handle}</tt>.
            </p>
          </hgroup>
        </header>
        {aliases && (
          <ul>
            {aliases.map(({ iri, handle }) => (
              <li>
                {handle == null ? (
                  <>
                    <tt>{iri}</tt> (The server is not available.)
                  </>
                ) : (
                  <>
                    <tt>{handle}</tt> (<tt>{iri}</tt>)
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form method="post" action="migrate/from">
          <fieldset role="group">
            <input
              type="text"
              name="handle"
              placeholder="@hollo@hollo.social"
              required
              {...(aliasesError === "from"
                ? { "aria-invalid": "true", value: aliasesHandle }
                : {})}
            />
            <button type="submit">Add</button>
          </fieldset>
          <small>
            A fediverse handle (e.g., <tt>@hollo@hollo.social</tt>) or an actor
            URI (e.g., <tt>https://hollo.social/@hollo</tt>) is allowed.
          </small>
        </form>
      </article>

      <article>
        <header>
          <hgroup>
            <h2>Migrating {username} to new account</h2>
            <p>
              Migrate <tt>{accountOwner.account.handle}</tt> to your new
              account. Note that this action is <strong>irreversible</strong>.
            </p>
          </hgroup>
        </header>
        <form method="post" action="migrate/to">
          <fieldset role="group">
            <input
              type="text"
              name="handle"
              placeholder={HOLLO_OFFICIAL_ACCOUNT}
              required
              {...(aliasesError === "to"
                ? { "aria-invalid": "true", value: aliasesHandle }
                : { value: accountOwner.account.successor?.handle })}
              {...(accountOwner.account.successorId == null
                ? {}
                : { disabled: true })}
            />
            {accountOwner.account.successorId == null ? (
              <button type="submit">Migrate</button>
            ) : (
              <button type="submit" disabled>
                Migrated
              </button>
            )}
          </fieldset>
          <small>
            A fediverse handle (e.g., <tt>@hollo@hollo.social</tt>) or an actor
            URI (e.g., <tt>https://hollo.social/@hollo</tt>) is allowed.{" "}
            <strong>
              The new account must have an alias to this old account.
            </strong>
          </small>
        </form>
      </article>

      <article>
        <header>
          <hgroup>
            <h2>Export data</h2>
            <p>
              Export your account data into CSV files. Note that these files are
              compatible with Mastodon.
            </p>
          </hgroup>
        </header>
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Entries</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Follows</td>
              <td>{followsCount.toLocaleString("en-US")}</td>
              <td>
                <a href="migrate/following_accounts.csv">CSV</a>
              </td>
            </tr>
            <tr>
              <td>Lists</td>
              <td>{listsCount.toLocaleString("en-US")}</td>
              <td>
                <a href="migrate/lists.csv">CSV</a>
              </td>
            </tr>
            <tr>
              <td>You mute</td>
              <td>{mutesCount.toLocaleString("en-US")}</td>
              <td>
                <a href="migrate/muted_accounts.csv">CSV</a>
              </td>
            </tr>
            <tr>
              <td>You block</td>
              <td>{blocksCount.toLocaleString("en-US")}</td>
              <td>
                <a href="migrate/blocked_accounts.csv">CSV</a>
              </td>
            </tr>
            <tr>
              <td>Bookmarks</td>
              <td>{bookmarksCount.toLocaleString("en-US")}</td>
              <td>
                <a href="migrate/bookmarks.csv">CSV</a>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article id="import-data">
        <header>
          <hgroup>
            <h2>Import data</h2>
            {importDataResult == null ? (
              <p>
                Import your account data from CSV files, which are exported from
                other Hollo or Mastodon instances. The existing data won't be
                overwritten, but the new data will be <strong>merged</strong>{" "}
                with the existing data.
              </p>
            ) : (
              <p>{importDataResult}</p>
            )}
          </hgroup>
        </header>
        <form
          method="post"
          action="migrate/import"
          encType="multipart/form-data"
          onsubmit={`
            const [submit] = this.getElementsByTagName('button');
            submit.disabled = true;
            submit.textContent = 'Importing… it may take a while…';
          `}
        >
          <fieldset class="grid">
            <label>
              Category
              <select name="category">
                <option value="following_accounts">Follows</option>
                <option value="lists">Lists</option>
                <option value="muted_accounts">Muted accounts</option>
                <option value="blocked_accounts">Blocked accounts</option>
                <option value="bookmarks">Bookmarks</option>
              </select>
              <small>The category of the data you want to import.</small>
            </label>
            <label>
              CSV file
              <input type="file" name="file" accept=".csv" />
              <small>
                A CSV file exported from other Hollo or Mastodon instances.
              </small>
            </label>
          </fieldset>
          <button type="submit">Import</button>
        </form>
      </article>
    </DashboardLayout>,
  );
});

accounts.post("/:id/migrate/from", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const form = await c.req.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string") {
    return c.redirect(`/accounts/${accountOwner.id}/migrate?error=from`);
  }
  const errorPage = `/accounts/${accountOwner.id}/migrate?error=from&handle=${encodeURIComponent(handle)}`;
  const documentLoader = await fedCtx.getDocumentLoader({
    username: accountOwner.handle,
  });
  let actor: Object | null = null;
  try {
    actor = await fedCtx.lookupObject(handle, { documentLoader });
  } catch {
    return c.redirect(errorPage);
  }
  if (!isActor(actor) || actor.id == null) {
    return c.redirect(errorPage);
  }
  const aliases = uniq([
    ...accountOwner.account.aliases,
    actor.id.href,
    ...actor.aliasIds.map((u) => u.href),
  ]);
  await db
    .update(accountsTable)
    .set({ aliases })
    .where(eq(accountsTable.id, accountOwner.id));
  return c.redirect(`/accounts/${accountOwner.id}/migrate`);
});

accounts.post("/:id/migrate/to", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const form = await c.req.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string") {
    logger.error("The handle is not a string: {handle}", { handle });
    return c.redirect(`/accounts/${accountOwner.id}/migrate?error=to`);
  }
  const errorPage = `/accounts/${accountOwner.id}/migrate?error=to&handle=${encodeURIComponent(handle)}`;
  const documentLoader = await fedCtx.getDocumentLoader({
    username: accountOwner.handle,
  });
  let target: Object | null = null;
  try {
    target = await fedCtx.lookupObject(handle, { documentLoader });
  } catch (error) {
    logger.error("Failed to lookup actor: {error}", { error });
    return c.redirect(errorPage);
  }
  if (
    !isActor(target) ||
    target.id == null ||
    !target.aliasIds.some((a) => a.href === accountOwner.account.iri)
  ) {
    logger.error(
      "The looked up object is either not an actor or does not have an alias to " +
        "the account: {object}",
      { object: target },
    );
    return c.redirect(errorPage);
  }
  const targetAccount = await persistAccount(db, target, c.req.url);
  if (targetAccount == null) {
    logger.error("Failed to persist the account: {actor}", { actor: target });
    return c.redirect(errorPage);
  }
  await db
    .update(accountsTable)
    .set({ successorId: targetAccount.id })
    .where(eq(accountsTable.id, accountOwner.id));
  await fedCtx.sendActivity(
    { username: accountOwner.handle },
    "followers",
    new Move({
      id: new URL("#move", accountOwner.account.iri),
      actor: new URL(accountOwner.account.iri),
      object: new URL(accountOwner.account.iri),
      target: target.id,
    }),
    { preferSharedInbox: true, excludeBaseUris: [fedCtx.url] },
  );
  return c.redirect(`/accounts/${accountOwner.id}/migrate`);
});

accounts.get("/:id/migrate/following_accounts.csv", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const csv = createObjectCsvStringifier({
    header: [
      { id: "handle", title: "Account address" },
      { id: "boosts", title: "Show boosts" },
      { id: "notify", title: "Notify on new posts" },
      { id: "languages", title: "Languages" },
    ],
  });
  c.header("Content-Type", "text/csv");
  c.header(
    "Content-Disposition",
    'attachment; filename="following_accounts.csv"',
  );
  return streamText(c, async (stream) => {
    await stream.write(csv.getHeaderString() ?? "");
    const following = await db.query.follows.findMany({
      with: { following: true },
      where: eq(follows.followerId, accountOwner.id),
    });
    for (const f of following) {
      const record = {
        handle: f.following.handle.replace(/^@/, ""),
        boosts: f.shares ? "true" : "false",
        notify: f.notify ? "true" : "false",
        languages: (f.languages ?? []).join(", "),
      };
      await stream.write(csv.stringifyRecords([record]));
    }
  });
});

accounts.get("/:id/migrate/lists.csv", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const csv = createObjectCsvStringifier({
    header: [
      { id: "list", title: "list" },
      { id: "handle", title: "handle" },
    ],
  });
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", 'attachment; filename="lists.csv"');
  return streamText(c, async (stream) => {
    const listObjects = await db.query.lists.findMany({
      with: { members: { with: { account: true } } },
      where: eq(lists.accountOwnerId, accountOwner.id),
    });
    for (const list of listObjects) {
      const records = list.members.map((m) => ({
        list: list.title,
        handle: m.account.handle.replace(/^@/, ""),
      }));
      await stream.write(csv.stringifyRecords(records));
    }
  });
});

accounts.get("/:id/migrate/muted_accounts.csv", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const csv = createObjectCsvStringifier({
    header: [
      { id: "handle", title: "Account address" },
      { id: "notifications", title: "Hide notifications" },
    ],
  });
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", 'attachment; filename="muted_accounts.csv"');
  return streamText(c, async (stream) => {
    await stream.write(csv.getHeaderString() ?? "");
    const mutedAccounts = await db.query.mutes.findMany({
      with: { targetAccount: true },
      where: eq(mutes.accountId, accountOwner.id),
    });
    for (const muted of mutedAccounts) {
      const record = {
        handle: muted.targetAccount.handle.replace(/^@/, ""),
        notifications: muted.notifications ? "true" : "false",
      };
      await stream.write(csv.stringifyRecords([record]));
    }
  });
});

accounts.get("/:id/migrate/blocked_accounts.csv", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const csv = createObjectCsvStringifier({
    header: [{ id: "handle", title: "handle" }],
  });
  c.header("Content-Type", "text/csv");
  c.header(
    "Content-Disposition",
    'attachment; filename="blocked_accounts.csv"',
  );
  return streamText(c, async (stream) => {
    const blockedAccounts = await db.query.blocks.findMany({
      with: { blockedAccount: true },
      where: eq(mutes.accountId, accountOwner.id),
    });
    for (const blocked of blockedAccounts) {
      const record = {
        handle: blocked.blockedAccount.handle.replace(/^@/, ""),
      };
      await stream.write(csv.stringifyRecords([record]));
    }
  });
});

accounts.get("/:id/migrate/bookmarks.csv", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const csv = createObjectCsvStringifier({
    header: [{ id: "iri", title: "iri" }],
  });
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", 'attachment; filename="bookmarks.csv"');
  return streamText(c, async (stream) => {
    const bookmarkList = await db.query.bookmarks.findMany({
      with: { post: true },
      where: eq(bookmarks.accountOwnerId, accountOwner.id),
    });
    for (const bookmark of bookmarkList) {
      const record = { iri: bookmark.post.iri };
      await stream.write(csv.stringifyRecords([record]));
    }
  });
});

accounts.post("/:id/migrate/import", async (c) => {
  const accountId = c.req.param("id");
  if (!isUuid(accountId)) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
    with: { account: true },
  });
  if (accountOwner == null) return c.notFound();
  const formData = await c.req.formData();
  const category = formData.get("category");
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return new Response("Invalid file", { status: 400 });
  }
  let csvText = await file.text();
  if (
    category === "following_accounts" &&
    !csvText.match(/^Account address,/)
  ) {
    csvText = `Account address,Show boosts,Notify on new posts,Languages\n${csvText}`;
  }
  const csv = await neatCsv(csvText, {
    headers:
      category === "following_accounts" || category === "muted_accounts"
        ? undefined
        : false,
  });
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const documentLoader = await fedCtx.getDocumentLoader({
    username: accountOwner.handle,
  });
  let message = "Failed to import data.";
  if (category === "following_accounts") {
    const accounts: Record<
      string,
      { shares: boolean; notify: boolean; languages?: string[] }
    > = {};
    for (const row of csv) {
      const handle = row["Account address"].trim();
      const shares =
        row["Show boosts"] == null
          ? true
          : row["Show boosts"].toLowerCase().trim() === "true";
      const notify =
        row["Notify on new posts"] == null
          ? false
          : row["Notify on new posts"].toLowerCase().trim() === "true";
      // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this
      const languages = row["Languages"]?.toLowerCase()?.trim() ?? "";
      accounts[handle] = {
        shares,
        notify,
        languages: languages === "" ? undefined : languages.split(/,\s+/g),
      };
    }
    const { results } = await PromisePool.for(
      globalThis.Object.keys(accounts),
    ).process(
      async (handle) =>
        [
          handle,
          await fedCtx.lookupObject(handle, { documentLoader }),
        ] as const,
    );
    let imported = 0;
    await db.transaction(async (tx) => {
      for (const [handle, actor] of results) {
        if (!isActor(actor)) continue;
        const { shares, notify, languages } = accounts[handle];
        let target: (Account & { owner: AccountOwner | null }) | null;
        try {
          target = await persistAccount(tx, actor, c.req.url, fedCtx);
        } catch (error) {
          logger.error("Failed to persist account: {error}", { error });
          continue;
        }
        if (target == null) continue;
        await followAccount(
          tx,
          fedCtx,
          { ...accountOwner.account, owner: accountOwner },
          target,
          { shares, notify, languages },
        );
        imported++;
      }
    });
    message = `Followed ${imported} accounts out of ${csv.length} entries.`;
  } else if (category === "lists") {
    const accounts: Record<
      string,
      (Account & { owner: AccountOwner | null }) | null
    > = {};
    for (const row of csv) accounts[row[1].trim()] = null;
    const existingAccounts = await db.query.accounts.findMany({
      with: { owner: true },
      where: inArray(
        accountsTable.handle,
        globalThis.Object.keys(accounts).map((handle) =>
          handle.replace(/^@?/, "@"),
        ),
      ),
    });
    for (const account of existingAccounts) {
      accounts[account.handle.replace(/^@/, "")] = account;
    }
    const handlesToFetch: string[] = [];
    for (const handle in accounts) {
      if (accounts[handle] != null) continue;
      handlesToFetch.push(handle);
    }
    const { results } = await PromisePool.for(handlesToFetch).process(
      async (handle) =>
        [
          handle,
          await fedCtx.lookupObject(handle, { documentLoader }),
        ] as const,
    );
    for (const [handle, actor] of results) {
      if (!isActor(actor)) continue;
      let account: (Account & { owner: AccountOwner | null }) | null;
      try {
        account = await persistAccount(db, actor, c.req.url, fedCtx);
      } catch (error) {
        logger.error("Failed to persist account: {error}", { error });
        continue;
      }
      if (account == null) continue;
      accounts[handle] = account;
    }
    const listNames = new Set(csv.map((row) => row[0].trim()));
    const listIds: Record<string, Uuid> = {};
    for (const listName of listNames) {
      let list = await db.query.lists.findFirst({
        where: and(
          eq(lists.accountOwnerId, accountOwner.id),
          eq(lists.title, listName),
        ),
      });
      if (list == null) {
        const result = await db
          .insert(lists)
          .values({
            id: crypto.randomUUID(),
            title: listName,
            accountOwnerId: accountOwner.id,
          })
          .onConflictDoNothing()
          .returning();
        if (result.length < 1) continue;
        list = result[0];
      }
      if (list == null) continue;
      listIds[listName] = list.id;
    }
    let imported = 0;
    const followed = new Set<string>();
    await db.transaction(async (tx) => {
      for (const row of csv) {
        const listId = listIds[row[0].trim()];
        if (listId == null) continue;
        const handle = row[1].trim();
        const account = accounts[handle];
        if (account == null) continue;
        if (!followed.has(handle)) {
          try {
            await followAccount(
              tx,
              fedCtx,
              { ...accountOwner.account, owner: accountOwner },
              account,
            );
          } catch (error) {
            logger.error("Failed to follow account: {error}", { error });
            continue;
          }
        }
        followed.add(handle);
        await tx
          .insert(listMembers)
          .values({
            listId,
            accountId: account.id,
          })
          .onConflictDoNothing();
        imported++;
      }
    });
    message = `Imported ${imported} list members out of ${csv.length} entries.`;
  } else if (category === "muted_accounts") {
    const accounts = csv
      .map((row) => row["Account address"].trim())
      .filter((addr) => addr != null);
    const notifications = globalThis.Object.fromEntries(
      csv.map(
        (row) =>
          [
            row["Account address"].trim(),
            row["Hide notifications"].toLowerCase().trim() === "true",
          ] as const,
      ),
    );
    const { results } = await PromisePool.for(accounts).process(
      async (handle) =>
        [
          handle,
          await fedCtx.lookupObject(handle, { documentLoader }),
        ] as const,
    );
    const actors: Record<string, [Actor, boolean]> = {};
    for (const [handle, actor] of results) {
      if (isActor(actor)) actors[handle] = [actor, notifications[handle]];
    }
    let imported = 0;
    await db.transaction(async (tx) => {
      for (const handle in actors) {
        const [actor, notifications] = actors[handle];
        let target: Account | null;
        try {
          target = await persistAccount(tx, actor, c.req.url, fedCtx);
        } catch (error) {
          logger.error("Failed to persist account: {error}", { error });
          continue;
        }
        if (target == null) continue;
        await tx
          .insert(mutes)
          .values({
            id: crypto.randomUUID(),
            accountId: accountOwner.id,
            mutedAccountId: target.id,
            notifications,
          })
          .onConflictDoNothing();
        imported++;
      }
    });
    message = `Imported ${imported} muted accounts out of ${csv.length} entries.`;
  } else if (category === "blocked_accounts") {
    const accounts = csv
      .map((row) => row[0].trim())
      .filter((addr) => addr != null);
    const { results } = await PromisePool.for(accounts).process((handle) =>
      fedCtx.lookupObject(handle, { documentLoader }),
    );
    let blocked = 0;
    for (const actor of results) {
      if (!isActor(actor)) continue;
      await db.transaction(async (tx) => {
        const target = await persistAccount(tx, actor, c.req.url, fedCtx);
        if (target == null) return;
        await blockAccount(tx, fedCtx, accountOwner, target);
        blocked++;
      });
    }
    message = `Blocked ${blocked} accounts out of ${csv.length} entries.`;
  } else if (category === "bookmarks") {
    const iris = csv.map((row) => row[0].trim()).filter((iri) => iri != null);
    const { results } = await PromisePool.for(iris).process(async (iri) => {
      try {
        return await fedCtx.lookupObject(iri, { documentLoader });
      } catch (error) {
        logger.error("Failed to lookup object: {error}", { error });
        return null;
      }
    });
    let imported = 0;
    await db.transaction(async (tx) => {
      for (const obj of results) {
        if (!isPost(obj)) continue;
        let post: Post | null;
        try {
          post = await persistPost(tx, obj, c.req.url, fedCtx);
        } catch (error) {
          logger.error("Failed to persist post: {error}", { error });
          continue;
        }
        if (post == null) continue;
        await tx
          .insert(bookmarks)
          .values({ postId: post.id, accountOwnerId: accountOwner.id })
          .onConflictDoNothing();
        imported++;
      }
    });
    message = `Imported ${imported} bookmarks out of ${csv.length} entries.`;
  } else {
    return new Response("Invalid category", { status: 400 });
  }
  return c.redirect(
    `/accounts/${accountOwner.id}/migrate?import-data-result=${encodeURIComponent(message)}#import-data`,
  );
});

export default accounts;
