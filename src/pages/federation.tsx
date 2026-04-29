import { isActor } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { count, sql } from "drizzle-orm";
import { Hono } from "hono";

import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import federation from "../federation";
import {
  AccountHandleConflictError,
  persistAccount,
} from "../federation/account";
import { isPost, persistPost } from "../federation/post";
import { loginRequired } from "../login";

const logger = getLogger(["hollo", "pages", "federation"]);

const data = new Hono();

data.use(loginRequired);

data.get("/", async (c) => {
  const done = c.req.query("done");
  const error = c.req.query("error");

  let queueMessages: { type: string; number: number }[];
  try {
    queueMessages = await db
      .select({
        type: sql<string>`fedify_message_v2.message ->> 'type'`,
        number: count(),
      })
      .from(sql`fedify_message_v2`)
      .groupBy(sql`fedify_message_v2.message ->> 'type'`)
      .execute();
  } catch {
    queueMessages = [];
  }

  const refreshError =
    error === "refresh" || error === "refresh:account-conflict";
  return c.html(
    <DashboardLayout title="Hollo: Federation" selectedMenu="federation">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Federation
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Manage remote objects and interactions with the fediverse.
        </p>
      </header>

      <div class="space-y-6">
        <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <header class="mb-4">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Force refresh account or post
            </h2>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {done === "refresh:account"
                ? "The account has been refreshed."
                : done === "refresh:post"
                  ? "The post has been refreshed."
                  : error === "refresh:account-conflict"
                    ? "Refresh blocked by a canonical handle conflict."
                    : "Use this when you see outdated remote account or post data."}
            </p>
          </header>
          <form
            method="post"
            action="/federation/refresh"
            onsubmit="this.submit.ariaBusy = 'true'"
          >
            <div class="flex gap-2">
              <input
                type="text"
                name="uri"
                placeholder="@hollo@hollo.social"
                required
                aria-invalid={refreshError ? "true" : undefined}
                class={`flex-1 rounded-md border bg-white px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 ${
                  refreshError
                    ? "border-red-500"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              />
              <button
                name="submit"
                type="submit"
                class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
              >
                Refresh
              </button>
            </div>
            <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              {error === "refresh" ? (
                <>
                  The given handle or URI is invalid or not found. Please try
                  again.
                </>
              ) : error === "refresh:account-conflict" ? (
                <>
                  Hollo could not verify that this actor canonically owns the
                  handle already cached in the database, so the stale account
                  was not deleted automatically.
                </>
              ) : (
                <>
                  A fediverse handle (e.g.{" "}
                  <code class="font-mono">@hollo@hollo.social</code>) or a
                  post/actor URI is allowed.
                </>
              )}
            </p>
          </form>
        </section>

        <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <header class="mb-4">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Task queue
            </h2>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Pending messages, grouped by activity type.
            </p>
          </header>
          {queueMessages.length > 0 ? (
            <div class="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table class="w-full text-sm">
                <thead class="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
                  <tr>
                    <th class="px-3 py-2 text-left font-semibold">Type</th>
                    <th class="px-3 py-2 text-right font-semibold">Messages</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
                  {queueMessages.map((queueMessage) => (
                    <tr>
                      <td class="px-3 py-2 font-mono text-neutral-900 dark:text-neutral-100">
                        {queueMessage.type}
                      </td>
                      <td class="px-3 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                        {queueMessage.number.toLocaleString("en")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="text-sm text-neutral-500 dark:text-neutral-400">
              The task queue is empty.
            </p>
          )}
        </section>

        <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <header class="mb-3">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              How to shut down your instance
            </h2>
          </header>
          <p class="text-sm text-neutral-700 dark:text-neutral-300">
            Hollo does not provide a so-called{" "}
            <q class="italic">self-destruct</q> feature. You can achieve the
            same effect by deleting all{" "}
            <a
              href="/accounts"
              class="text-brand-700 underline-offset-2 hover:underline dark:text-brand-400"
            >
              your accounts
            </a>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>,
  );
});

data.post("/refresh", async (c) => {
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const form = await c.req.formData();
  const uri = form.get("uri");
  const owner = await db.query.accountOwners.findFirst({});
  if (owner != null && typeof uri === "string") {
    const documentLoader = await fedCtx.getDocumentLoader({
      username: owner.handle,
    });
    try {
      const object = await fedCtx.lookupObject(uri, { documentLoader });
      if (isActor(object)) {
        await persistAccount(db, object, c.req.url, {
          ...fedCtx,
          documentLoader,
        });
        return c.redirect("/federation?done=refresh:account");
      }
      if (isPost(object)) {
        await persistPost(db, object, c.req.url, { ...fedCtx, documentLoader });
        return c.redirect("/federation?done=refresh:post");
      }
    } catch (error) {
      if (error instanceof AccountHandleConflictError) {
        logger.warning(
          "Canonical handle conflict while force-refreshing actor {actorIri}: handle {handle} is still occupied by {conflictingIri}.",
          {
            actorIri: error.actorIri,
            handle: error.handle,
            conflictingIri: error.conflictingAccount.iri,
          },
        );
        return c.redirect("/federation?error=refresh:account-conflict");
      }
      logger.error("Failed to refresh: {error}", { error });
    }
  }
  return c.redirect("/federation?error=refresh");
});

export default data;
