import { statSync } from "node:fs";
import { join } from "node:path";

import type { PropsWithChildren } from "hono/jsx";

import type { ThemeColor } from "../schema";
import { themeColorVariables } from "../theme/colors";

const UNO_CSS_PATH = join(import.meta.dirname, "..", "public", "uno.css");

function unoCssVersion(): string {
  try {
    return Math.floor(statSync(UNO_CSS_PATH).mtimeMs).toString(36);
  } catch {
    return "0";
  }
}

export interface LayoutProps {
  title: string;
  shortTitle?: string | null;
  url?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  links?: { href: string | URL; rel: string; type?: string }[];
  themeColor?: ThemeColor;
}

export function Layout(props: PropsWithChildren<LayoutProps>) {
  const themeColor = props.themeColor ?? "azure";
  return (
    <html lang="en" style={themeColorVariables(themeColor)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta property="og:title" content={props.shortTitle ?? props.title} />
        {props.description && (
          <>
            <meta name="description" content={props.description} />
            <meta property="og:description" content={props.description} />
          </>
        )}
        {props.url && (
          <>
            <link rel="canonical" href={props.url} />
            <meta property="og:url" content={props.url} />
          </>
        )}
        {props.imageUrl && (
          <meta property="og:image" content={props.imageUrl} />
        )}
        {props.links?.map((link) => (
          <link
            rel={link.rel}
            href={link.href instanceof URL ? link.href.href : link.href}
            type={link.type}
          />
        ))}
        <link rel="stylesheet" href={`/public/uno.css?v=${unoCssVersion()}`} />
        <link
          rel="icon"
          type="image/png"
          sizes="500x500"
          href="/public/favicon.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="500x500"
          href="/public/favicon-white.png"
          media="(prefers-color-scheme: dark)"
        />
      </head>
      <body class="min-h-screen bg-neutral-50 text-neutral-900 font-sans antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {props.children}
      </body>
    </html>
  );
}
