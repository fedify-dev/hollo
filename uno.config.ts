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
  theme: {
    colors: {
      brand: {
        50: "rgb(var(--theme-50) / <alpha-value>)",
        100: "rgb(var(--theme-100) / <alpha-value>)",
        200: "rgb(var(--theme-200) / <alpha-value>)",
        300: "rgb(var(--theme-300) / <alpha-value>)",
        400: "rgb(var(--theme-400) / <alpha-value>)",
        500: "rgb(var(--theme-500) / <alpha-value>)",
        600: "rgb(var(--theme-600) / <alpha-value>)",
        700: "rgb(var(--theme-700) / <alpha-value>)",
        800: "rgb(var(--theme-800) / <alpha-value>)",
        900: "rgb(var(--theme-900) / <alpha-value>)",
        950: "rgb(var(--theme-950) / <alpha-value>)",
        DEFAULT: "rgb(var(--theme-500) / <alpha-value>)",
      },
    },
  },
  content: {
    pipeline: {
      include: [/\.(tsx|ts)($|\?)/],
    },
  },
});
