import type { PropsWithChildren } from "hono/jsx";

export interface AuthCardProps {
  title: string;
  subtitle?: string;
}

export function AuthCard(props: PropsWithChildren<AuthCardProps>) {
  return (
    <div class="min-h-screen flex items-center justify-center px-4 py-12">
      <div class="w-full max-w-md">
        <div class="mb-8 flex flex-col items-center">
          <picture>
            <source
              srcset="/public/logo-white.svg"
              media="(prefers-color-scheme: dark)"
            />
            <img
              src="/public/logo-black.svg"
              width={56}
              height={56}
              alt="Hollo"
            />
          </picture>
        </div>
        <div class="rounded-xl border border-neutral-200 bg-white px-6 py-8 sm:px-8 dark:border-neutral-800 dark:bg-neutral-900">
          <div class="mb-6">
            <h1 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {props.title}
            </h1>
            {props.subtitle && (
              <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {props.subtitle}
              </p>
            )}
          </div>
          {props.children}
        </div>
      </div>
    </div>
  );
}
