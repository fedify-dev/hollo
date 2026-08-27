import {
  defineConfig,
  presetIcons,
  presetTypography,
  presetWebFonts,
  presetWind4,
} from "unocss";

export default defineConfig({
  presets: [
    presetWind4({
      preflights: { reset: true },
      dark: "media",
    }),
    presetIcons({
      scale: 1,
      extraProperties: {
        display: "inline-block",
        "vertical-align": "-0.125em",
      },
    }),
    presetTypography(),
    presetWebFonts({
      provider: "bunny",
      fonts: {
        sans: [{ name: "Inter", weights: ["400", "500", "600", "700"] }],
        mono: [{ name: "JetBrains Mono", weights: ["400", "500", "700"] }],
      },
    }),
  ],
  preflights: [
    {
      getCSS: () => `
        :root {
          --un-bg-opacity: 100%;
          --un-text-opacity: 100%;
          --un-border-opacity: 100%;
          --un-ring-opacity: 100%;
          --un-divide-opacity: 100%;
          --un-placeholder-opacity: 100%;
          --font-sans-ko:
            "Inter", "Noto Sans KR", "Noto Sans CJK KR",
            "Apple SD Gothic Neo", "Malgun Gothic",
            ui-sans-serif, system-ui, sans-serif;
          --font-sans-ja:
            "Inter", "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans",
            "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo,
            ui-sans-serif, system-ui, sans-serif;
          --font-sans-zh-hans:
            "Inter", "Noto Sans SC", "Noto Sans CJK SC", "PingFang SC",
            "Microsoft YaHei UI", "Microsoft YaHei",
            ui-sans-serif, system-ui, sans-serif;
          --font-sans-zh-hant:
            "Inter", "Noto Sans TC", "Noto Sans CJK TC", "PingFang TC",
            "Microsoft JhengHei UI", "Microsoft JhengHei",
            ui-sans-serif, system-ui, sans-serif;
          --font-sans-zh-hk:
            "Inter", "Noto Sans HK", "Noto Sans CJK HK", "PingFang HK",
            "Microsoft JhengHei UI", "Microsoft JhengHei",
            ui-sans-serif, system-ui, sans-serif;
        }
        /* Match explicit language boundaries so nested code keeps its
           monospace font while inheriting the surrounding language. */
        :where([lang|="ko" i]) {
          font-family: var(--font-sans-ko);
        }
        :where([lang|="ja" i]) {
          font-family: var(--font-sans-ja);
        }
        :where(
          [lang="zh" i],
          [lang|="zh-Hans" i],
          [lang|="zh-CN" i],
          [lang|="zh-SG" i]
        ) {
          font-family: var(--font-sans-zh-hans);
        }
        :where(
          [lang|="zh-Hant" i],
          [lang|="zh-TW" i],
          [lang|="zh-MO" i]
        ) {
          font-family: var(--font-sans-zh-hant);
        }
        :where(
          [lang|="zh" i][lang$="-HK" i]:not([lang*="-Hans-" i]),
          [lang|="zh" i][lang*="-HK-" i]:not([lang*="-Hans-" i])
        ) {
          font-family: var(--font-sans-zh-hk);
        }
        input:where(:not([type="file"], [type="checkbox"], [type="radio"])),
        textarea,
        select {
          border-style: solid;
          border-width: 1px;
        }
        button:not(:disabled), [role="button"]:not(:disabled) {
          cursor: pointer;
        }
        button:disabled, [role="button"][aria-disabled="true"] {
          cursor: not-allowed;
        }
        ::selection {
          background-color: rgb(var(--theme-200));
          color: rgb(var(--theme-900));
        }
        @media (prefers-color-scheme: dark) {
          ::selection {
            background-color: rgb(var(--theme-800));
            color: rgb(var(--theme-100));
          }
        }
        /* UnoCSS sorts the .dark:divide-* rule alphabetically before the
           .divide-* rule (dark < divide), so the light value would win in
           dark mode.  Pin a sensible default for both schemes here. */
        .divide-y > :not(:last-child) {
          border-color: rgb(229 229 229);
        }
        @media (prefers-color-scheme: dark) {
          .divide-y > :not(:last-child) {
            border-color: rgb(38 38 38);
          }
        }
        @media (prefers-color-scheme: dark) {
          .shiki, .shiki span {
            color: var(--shiki-dark) !important;
            background-color: var(--shiki-dark-bg) !important;
            font-style: var(--shiki-dark-font-style) !important;
            font-weight: var(--shiki-dark-font-weight) !important;
            text-decoration: var(--shiki-dark-text-decoration) !important;
          }
        }
      `,
    },
  ],
  theme: {
    colors: {
      brand: {
        50: "rgb(var(--theme-50))",
        100: "rgb(var(--theme-100))",
        200: "rgb(var(--theme-200))",
        300: "rgb(var(--theme-300))",
        400: "rgb(var(--theme-400))",
        500: "rgb(var(--theme-500))",
        600: "rgb(var(--theme-600))",
        700: "rgb(var(--theme-700))",
        800: "rgb(var(--theme-800))",
        900: "rgb(var(--theme-900))",
        950: "rgb(var(--theme-950))",
        DEFAULT: "rgb(var(--theme-500))",
      },
    },
  },
  content: {
    pipeline: {
      include: [/\.(tsx|ts)($|\?)/],
    },
  },
});
