import { and, count, desc, eq, ilike, isNotNull, or } from "drizzle-orm";
import { type Context, Hono } from "hono";

import { Layout } from "../../components/Layout.tsx";
import { type ProfileAccount, Profile } from "../../components/Profile.tsx";
import { PublicAccountList } from "../../components/PublicAccountList.tsx";
import { db } from "../../db.ts";
import {
  type Account,
  type AccountOwner,
  accounts,
  follows,
} from "../../schema.ts";

const PAGE_SIZE = 100;
const numberFormatter = new Intl.NumberFormat("en-US");

const followsApp = new Hono();

type Kind = "followers" | "following";

async function loadOwner(c: Context) {
  let handle = c.req.param("handle");
  if (handle == null) return null;
  if (handle.startsWith("@")) handle = handle.substring(1);
  const owner = await db.query.accountOwners.findFirst({
    where: { handle: { eq: handle } },
    with: { account: { with: { successor: true } } },
  });
  return owner ?? null;
}

function parsePage(c: Context): number | null {
  const pageStr = c.req.query("page");
  if (pageStr === undefined) return 1;
  if (!/^\d+$/.test(pageStr)) return null;
  const parsed = Number.parseInt(pageStr, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  // Reject pages whose offset would overflow safe-integer arithmetic.
  if (parsed > Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE)) return null;
  return parsed;
}

function parseQuery(c: Context): string | undefined {
  const raw = c.req.query("q");
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function buildPaginationUrls(
  page: number,
  hasNext: boolean,
  query: string | undefined,
): { newerUrl?: string; olderUrl?: string } {
  function build(targetPage: number): string {
    const params = new URLSearchParams();
    params.set("page", String(targetPage));
    if (query != null) params.set("q", query);
    return `?${params.toString()}`;
  }
  return {
    newerUrl: page > 1 ? build(page - 1) : undefined,
    olderUrl: hasNext ? build(page + 1) : undefined,
  };
}

async function renderFollowsPage(c: Context, kind: Kind) {
  const owner = await loadOwner(c);
  if (owner == null) return c.notFound();
  if (kind === "following" && !owner.followingListPublic) {
    return c.notFound();
  }
  const page = parsePage(c);
  if (page == null) return c.notFound();
  const query = parseQuery(c);

  const ownerColumn =
    kind === "followers" ? follows.followingId : follows.followerId;
  const otherColumn =
    kind === "followers" ? follows.followerId : follows.followingId;
  const pattern = query == null ? null : `%${escapeLike(query)}%`;
  const where = and(
    eq(ownerColumn, owner.id),
    isNotNull(follows.approved),
    pattern == null
      ? undefined
      : or(ilike(accounts.name, pattern), ilike(accounts.handle, pattern)),
  );

  const [{ total }] =
    pattern == null
      ? await db.select({ total: count() }).from(follows).where(where)
      : await db
          .select({ total: count() })
          .from(follows)
          .innerJoin(accounts, eq(otherColumn, accounts.id))
          .where(where);

  if (page > 1 && total === 0) return c.notFound();
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > maxPage) return c.notFound();

  const rows = await db
    .select({ account: accounts })
    .from(follows)
    .innerJoin(accounts, eq(otherColumn, accounts.id))
    .where(where)
    .orderBy(desc(follows.approved), desc(otherColumn))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const { newerUrl, olderUrl } = buildPaginationUrls(
    page,
    page * PAGE_SIZE < total,
    query,
  );

  return c.html(
    <FollowsPage
      kind={kind}
      accountOwner={owner}
      accounts={rows.map((r) => r.account)}
      total={total}
      query={query}
      newerUrl={newerUrl}
      olderUrl={olderUrl}
      baseUrl={c.req.url}
    />,
  );
}

followsApp.get("/followers", (c) => renderFollowsPage(c, "followers"));
followsApp.get("/following", (c) => renderFollowsPage(c, "following"));

interface FollowsPageProps {
  readonly kind: Kind;
  readonly accountOwner: AccountOwner & { account: ProfileAccount };
  readonly accounts: Account[];
  readonly total: number;
  readonly query: string | undefined;
  readonly newerUrl?: string;
  readonly olderUrl?: string;
  readonly baseUrl: URL | string;
}

function FollowsPage({
  kind,
  accountOwner,
  accounts: accountList,
  total,
  query,
  newerUrl,
  olderUrl,
  baseUrl,
}: FollowsPageProps) {
  const heading = kind === "followers" ? "Followers" : "Following";
  const countLabel = numberFormatter.format(total);
  let emptyText: string;
  if (query != null) {
    emptyText = "No matches found.";
  } else if (kind === "followers") {
    emptyText = "No followers yet.";
  } else {
    emptyText = "Not following anyone yet.";
  }
  const emptyIcon =
    kind === "followers" ? "i-lucide-users" : "i-lucide-user-plus";
  return (
    <Layout
      title={`${heading} — ${accountOwner.account.name}`}
      shortTitle={heading}
      description={accountOwner.bio}
      imageUrl={accountOwner.account.avatarUrl}
      themeColor={accountOwner.themeColor}
    >
      <main class="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
        <Profile accountOwner={accountOwner} baseUrl={baseUrl} />
        <section class="mt-10">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {heading}
              <span class="ms-2 text-sm font-normal text-neutral-500 dark:text-neutral-400">
                {countLabel}
              </span>
            </h2>
            <form method="get" role="search" class="w-full sm:w-72">
              <label class="sr-only" htmlFor="follows-search">
                Search by name or handle
              </label>
              <div class="relative">
                <span
                  class="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-neutral-400 dark:text-neutral-500"
                  aria-hidden="true"
                >
                  <span class="i-lucide-search" />
                </span>
                <input
                  id="follows-search"
                  type="search"
                  name="q"
                  value={query ?? ""}
                  placeholder="Filter by name or handle"
                  aria-label="Search by name or handle"
                  autoComplete="off"
                  class="w-full rounded-md border border-neutral-300 bg-white py-2 ps-9 pe-3 text-sm text-neutral-900 shadow-sm transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900"
                />
              </div>
            </form>
          </div>
          {accountList.length === 0 ? (
            <div class="mt-10 flex flex-col items-center gap-3 py-10 text-center">
              <span
                class={`${emptyIcon} text-3xl text-neutral-400 dark:text-neutral-500`}
                aria-hidden="true"
              />
              <p class="text-sm text-neutral-500 dark:text-neutral-400">
                {emptyText}
              </p>
            </div>
          ) : (
            <PublicAccountList accounts={accountList} baseUrl={baseUrl} />
          )}
        </section>
        {(newerUrl || olderUrl) && (
          <nav class="mt-8 flex items-center justify-between gap-4">
            <div>
              {newerUrl && (
                <a
                  href={newerUrl}
                  class="inline-flex items-center gap-1 text-sm text-neutral-600 transition-colors hover:text-brand-700 dark:text-neutral-400 dark:hover:text-brand-400"
                >
                  <span class="i-lucide-arrow-left" aria-hidden="true" />
                  Newer
                </a>
              )}
            </div>
            <div>
              {olderUrl && (
                <a
                  href={olderUrl}
                  class="inline-flex items-center gap-1 text-sm text-neutral-600 transition-colors hover:text-brand-700 dark:text-neutral-400 dark:hover:text-brand-400"
                >
                  Older
                  <span class="i-lucide-arrow-right" aria-hidden="true" />
                </a>
              )}
            </div>
          </nav>
        )}
      </main>
    </Layout>
  );
}

export default followsApp;
