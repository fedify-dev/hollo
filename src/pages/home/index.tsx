import { escape } from "es-toolkit";
import { Hono } from "hono";

import { Layout } from "../../components/Layout.tsx";
import { renderCustomEmojis } from "../../custom-emoji.ts";
import db from "../../db.ts";

const homePage = new Hono().basePath("/");

homePage.get("/", async (c) => {
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.redirect("/setup");
  const owners = await db.query.accountOwners.findMany({
    with: { account: true },
  });
  if (owners.length < 1) return c.redirect("/accounts");
  if (
    "HOME_URL" in process.env &&
    // oxlint-disable-next-line typescript/dot-notation
    process.env["HOME_URL"] != null &&
    // oxlint-disable-next-line typescript/dot-notation
    process.env["HOME_URL"].trim() !== ""
  ) {
    // oxlint-disable-next-line typescript/dot-notation
    return c.redirect(process.env["HOME_URL"]);
  }
  const host = new URL(c.req.url).host;
  const themeColor = owners[0]?.themeColor;
  return c.html(
    <Layout title={host} themeColor={themeColor}>
      <main class="mx-auto w-full max-w-2xl px-4 py-12 sm:py-16">
        <header class="mb-10 text-center">
          <picture class="inline-block">
            <source
              srcset="/public/logo-white.svg"
              media="(prefers-color-scheme: dark)"
            />
            <img
              src="/public/logo-black.svg"
              width={48}
              height={48}
              alt=""
              class="mx-auto"
            />
          </picture>
          <h1 class="mt-4 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
            {host}
          </h1>
          <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            This Hollo instance hosts the following{" "}
            {owners.length === 1 ? "account" : "accounts"}.
          </p>
        </header>
        <ul class="space-y-4">
          {owners.map((owner) => {
            const url = owner.account.url ?? owner.account.iri;
            const nameHtml = renderCustomEmojis(
              escape(owner.account.name),
              owner.account.emojis,
            );
            const bioHtml = renderCustomEmojis(
              owner.account.bioHtml ?? "",
              owner.account.emojis,
            );
            return (
              <li>
                <article class="rounded-xl border border-neutral-200 bg-white p-5 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700">
                  <div class="flex items-start gap-4">
                    {owner.account.avatarUrl && (
                      <a href={url} class="shrink-0">
                        <img
                          src={owner.account.avatarUrl}
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
                          href={url}
                          dangerouslySetInnerHTML={{ __html: nameHtml }}
                          class="hover:text-brand-700 dark:hover:text-brand-400"
                        />
                      </h2>
                      <p class="mt-0.5 select-all text-sm text-neutral-500 dark:text-neutral-400">
                        {owner.account.handle}
                      </p>
                      {bioHtml && (
                        <div
                          class="prose prose-sm prose-neutral dark:prose-invert mt-3 max-w-none"
                          dangerouslySetInnerHTML={{ __html: bioHtml }}
                        />
                      )}
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
        <div class="mt-10 text-center">
          <a
            href="/accounts"
            class="inline-flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            <span class="i-lucide-settings" aria-hidden="true" />
            Administration dashboard
          </a>
        </div>
      </main>
    </Layout>,
  );
});

export default homePage;
