import {
  defineConfig,
  presetIcons,
  presetTypography,
  presetWebFonts,
  presetWind4,
  transformerVariantGroup,
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
        sans: [
          { name: "Inter", weights: ["400", "500", "600", "700"] },
          { name: "Noto Sans KR", weights: ["400", "500", "700"] },
          { name: "Noto Sans JP", weights: ["400", "500", "700"] },
          { name: "Noto Sans SC", weights: ["400", "500", "700"] },
        ],
        mono: [{ name: "JetBrains Mono", weights: ["400", "500", "700"] }],
      },
    }),
  ],
  transformers: [transformerVariantGroup()],
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
