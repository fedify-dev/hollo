import {
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
  followAccount,
  persistAccount,
  persistAccountPosts,
  REMOTE_ACTOR_FETCH_POSTS,
  unfollowAccount,
} from "../federation/account.ts";
import { loginRequired } from "../login.ts";
import {
  type Account,
  type AccountOwner,
  accountOwners,
  accounts as accountsTable,
  blocks,
  bookmarks,
  follows,
  type ImportJobCategory,
  importJobItems,
  importJobs,
  instances,
  listMembers,
  lists,
  mutes,
  type PostVisibility,
  type ThemeColor,
} from "../schema.ts";
import { extractCustomEmojis, formatText } from "../text.ts";
import { isUuid, uuidv7 } from "../uuid.ts";

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

  // Check for active import job (from query param or database)
  const importJobId = c.req.query("import-job");
  const activeJob =
    importJobId && isUuid(importJobId)
      ? await db.query.importJobs.findFirst({
          where: and(
            eq(importJobs.id, importJobId),
            eq(importJobs.accountOwnerId, accountOwner.id),
          ),
        })
      : await db.query.importJobs.findFirst({
          where: and(
            eq(importJobs.accountOwnerId, accountOwner.id),
            inArray(importJobs.status, ["pending", "processing"]),
          ),
          orderBy: (importJobs, { desc }) => [desc(importJobs.created)],
        });

  // Check if we need to auto-refresh (job in progress)
  const shouldAutoRefresh =
    activeJob?.status === "pending" || activeJob?.status === "processing";
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

      {/* Import Progress Section */}
      {activeJob && (
        <article id="import-progress">
          <header>
            <hgroup>
              <h2>
                {activeJob.status === "pending"
                  ? "Import Queued"
                  : activeJob.status === "processing"
                    ? "Import in Progress"
                    : activeJob.status === "completed"
                      ? "Import Completed"
                      : activeJob.status === "cancelled"
                        ? "Import Cancelled"
                        : "Import Failed"}
              </h2>
              <p>
                Importing {activeJob.category.replace(/_/g, " ")}
                {activeJob.status === "pending" && " (waiting to start)"}
                {activeJob.status === "processing" && "..."}
              </p>
            </hgroup>
          </header>

          <progress
            value={activeJob.processedItems}
            max={activeJob.totalItems}
          />

          <p>
            <strong>{activeJob.processedItems.toLocaleString("en-US")}</strong>{" "}
            / {activeJob.totalItems.toLocaleString("en-US")} items processed
            {activeJob.processedItems > 0 && (
              <>
                {" "}
                (
                <strong style={{ color: "var(--pico-ins-color)" }}>
                  {activeJob.successfulItems.toLocaleString("en-US")}
                </strong>{" "}
                successful
                {activeJob.failedItems > 0 && (
                  <>
                    ,{" "}
                    <strong style={{ color: "var(--pico-del-color)" }}>
                      {activeJob.failedItems.toLocaleString("en-US")}
                    </strong>{" "}
                    failed
                  </>
                )}
                )
              </>
            )}
          </p>

          {shouldAutoRefresh && (
            <>
              <form
                method="post"
                action={`migrate/import/${activeJob.id}/cancel`}
              >
                <button type="submit" class="secondary">
                  Cancel Import
                </button>
              </form>
              <small>
                This page refreshes automatically every 5 seconds. You can
                navigate away safely &mdash; the import will continue in the
                background.
              </small>
              <script
                dangerouslySetInnerHTML={{
                  __html: "setTimeout(() => location.reload(), 5000);",
                }}
              />
            </>
          )}

          {activeJob.status === "completed" && (
            <p style={{ color: "var(--pico-ins-color)" }}>
              Import completed successfully!
            </p>
          )}

          {activeJob.status === "cancelled" && (
            <p style={{ color: "var(--pico-del-color)" }}>
              Import was cancelled.
            </p>
          )}

          {activeJob.status === "failed" && activeJob.errorMessage && (
            <p style={{ color: "var(--pico-del-color)" }}>
              Error: {activeJob.errorMessage}
            </p>
          )}
        </article>
      )}

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
        >
          <fieldset
            class="grid"
            {...(shouldAutoRefresh ? { disabled: true } : {})}
          >
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
              <input type="file" name="file" accept=".csv" required />
              <small>
                A CSV file exported from other Hollo or Mastodon instances.
              </small>
            </label>
          </fieldset>
          <button
            type="submit"
            {...(shouldAutoRefresh ? { disabled: true } : {})}
          >
            {shouldAutoRefresh ? "Import in progress..." : "Import"}
          </button>
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
  const category = formData.get("category") as string;
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return new Response("Invalid file", { status: 400 });
  }

  // Validate category
  const validCategories: ImportJobCategory[] = [
    "following_accounts",
    "lists",
    "muted_accounts",
    "blocked_accounts",
    "bookmarks",
  ];
  if (!validCategories.includes(category as ImportJobCategory)) {
    return new Response("Invalid category", { status: 400 });
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

  if (csv.length === 0) {
    return c.redirect(
      `/accounts/${accountOwner.id}/migrate?import-data-result=${encodeURIComponent("No items to import")}#import-data`,
    );
  }

  // Parse items based on category
  let parsedItems: Record<string, unknown>[];

  if (category === "following_accounts") {
    parsedItems = csv.map((row) => ({
      handle: row["Account address"]?.trim(),
      shares:
        row["Show boosts"] == null
          ? true
          : row["Show boosts"].toLowerCase().trim() !== "false",
      notify:
        row["Notify on new posts"] == null
          ? false
          : row["Notify on new posts"].toLowerCase().trim() === "true",
      languages:
        row.Languages?.toLowerCase()?.trim() === ""
          ? undefined
          : row.Languages?.toLowerCase()?.trim()?.split(/,\s+/g),
    }));
  } else if (category === "muted_accounts") {
    parsedItems = csv.map((row) => ({
      handle: row["Account address"]?.trim(),
      notifications:
        row["Hide notifications"]?.toLowerCase()?.trim() === "true",
    }));
  } else if (category === "blocked_accounts") {
    parsedItems = csv.map((row) => ({
      handle: row[0]?.trim(),
    }));
  } else if (category === "bookmarks") {
    parsedItems = csv.map((row) => ({
      iri: row[0]?.trim(),
    }));
  } else if (category === "lists") {
    parsedItems = csv.map((row) => ({
      listName: row[0]?.trim(),
      handle: row[1]?.trim(),
    }));
  } else {
    return new Response("Invalid category", { status: 400 });
  }

  // Filter out invalid items
  parsedItems = parsedItems.filter((item) => {
    if (category === "bookmarks") {
      return (item as { iri?: string }).iri != null;
    }
    if (category === "lists") {
      return (
        (item as { listName?: string; handle?: string }).listName != null &&
        (item as { listName?: string; handle?: string }).handle != null
      );
    }
    return (item as { handle?: string }).handle != null;
  });

  if (parsedItems.length === 0) {
    return c.redirect(
      `/accounts/${accountOwner.id}/migrate?import-data-result=${encodeURIComponent("No valid items to import")}#import-data`,
    );
  }

  // Create the import job
  const jobId = uuidv7();
  await db.insert(importJobs).values({
    id: jobId,
    accountOwnerId: accountOwner.id,
    category: category as ImportJobCategory,
    totalItems: parsedItems.length,
  });

  // Create import job items in batches
  const itemValues = parsedItems.map((data) => ({
    id: uuidv7(),
    jobId,
    data,
  }));

  // Insert in batches of 1000 to avoid hitting query size limits
  for (let i = 0; i < itemValues.length; i += 1000) {
    await db.insert(importJobItems).values(itemValues.slice(i, i + 1000));
  }

  logger.info(
    "Created import job {jobId} with {count} items for category {category}",
    { jobId, count: parsedItems.length, category },
  );

  // Redirect to migrate page with job ID
  return c.redirect(
    `/accounts/${accountOwner.id}/migrate?import-job=${jobId}#import-data`,
  );
});

// Cancel import job endpoint
accounts.post("/:id/migrate/import/:jobId/cancel", async (c) => {
  const accountId = c.req.param("id");
  const jobId = c.req.param("jobId");

  if (!isUuid(accountId) || !isUuid(jobId)) return c.notFound();

  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountId),
  });
  if (accountOwner == null) return c.notFound();

  // Verify job belongs to this account owner
  const job = await db.query.importJobs.findFirst({
    where: and(
      eq(importJobs.id, jobId),
      eq(importJobs.accountOwnerId, accountId),
    ),
  });

  if (!job) return c.notFound();

  // Only allow cancellation of pending or processing jobs
  if (job.status !== "pending" && job.status !== "processing") {
    return c.redirect(
      `/accounts/${accountOwner.id}/migrate?import-data-result=${encodeURIComponent("Job cannot be cancelled")}#import-data`,
    );
  }

  // Mark job as cancelled
  await db
    .update(importJobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(importJobs.id, jobId));

  logger.info("Import job {jobId} cancelled by user", { jobId });

  return c.redirect(
    `/accounts/${accountOwner.id}/migrate?import-data-result=${encodeURIComponent("Import cancelled")}#import-data`,
  );
});

export default accounts;
