import type { PropsWithChildren } from "hono/jsx";

import metadata from "../../package.json";
import { Layout, type LayoutProps } from "./Layout";

export type Menu =
  | "accounts"
  | "emojis"
  | "federation"
  | "thumbnail_cleanup"
  | "auth";

export interface DashboardLayoutProps extends LayoutProps {
  selectedMenu?: Menu;
}

interface NavItem {
  menu: Menu;
  href: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { menu: "accounts", href: "/accounts", label: "Accounts" },
  { menu: "emojis", href: "/emojis", label: "Custom emojis" },
  { menu: "federation", href: "/federation", label: "Federation" },
  {
    menu: "thumbnail_cleanup",
    href: "/thumbnail_cleanup",
    label: "Thumbnail cleanup",
  },
  { menu: "auth", href: "/auth", label: "Auth" },
];

export function DashboardLayout(
  props: PropsWithChildren<DashboardLayoutProps>,
) {
  const { selectedMenu, children, ...layoutProps } = props;
  return (
    <Layout {...layoutProps}>
      <div class="min-h-screen flex flex-col">
        <header class="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <div class="mx-auto max-w-5xl px-4 py-3 flex flex-wrap items-center gap-4 sm:gap-6">
            <a
              href="/"
              class="flex items-center gap-2 font-semibold text-neutral-900 hover:opacity-80 dark:text-neutral-100"
            >
              <picture>
                <source
                  srcset="/public/logo-white.svg"
                  media="(prefers-color-scheme: dark)"
                />
                <img
                  src="/public/logo-black.svg"
                  width={28}
                  height={28}
                  alt=""
                />
              </picture>
              <span>Hollo</span>
              <span class="text-xs font-normal uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                Dashboard
              </span>
            </a>
            <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              {NAV_ITEMS.map((item) => {
                const active = selectedMenu === item.menu;
                return (
                  <a
                    href={item.href}
                    class={
                      active
                        ? "font-semibold text-neutral-900 dark:text-neutral-100"
                        : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                    }
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                );
              })}
            </nav>
            <form
              method="post"
              action="/logout"
              class="ms-auto inline-flex m-0"
            >
              <button
                type="submit"
                class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
              >
                Logout
              </button>
            </form>
          </div>
        </header>
        <main class="flex-1 mx-auto w-full max-w-3xl px-4 py-8">
          {children}
        </main>
        <footer class="border-t border-neutral-200 dark:border-neutral-800 mt-8">
          <div class="mx-auto max-w-5xl px-4 py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
            <strong class="font-semibold text-neutral-700 dark:text-neutral-300">
              Hollo
            </strong>{" "}
            · Version {metadata.version}
          </div>
        </footer>
      </div>
    </Layout>
  );
}
