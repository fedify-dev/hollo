import starlight from "@astrojs/starlight";
// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      components: {
        SocialIcons: "./src/components/SocialIcons.astro",
      },
      title: "Hollo",
      logo: {
        dark: "./src/assets/logo-white.svg",
        light: "./src/assets/logo-black.svg",
        replacesTitle: true,
      },
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/hGXXxUq2jK",
        },
        {
          icon: "matrix",
          label: "Matrix",
          href: "https://matrix.to/#/%23hollo-users:matrix.org",
        },
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/fedify-dev/hollo",
        },
      ],
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        ko: {
          label: "한국어",
        },
        ja: {
          label: "日本語",
        },
        "zh-cn": {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      sidebar: [
        {
          slug: "intro",
          label: "What is Hollo?",
          translations: {
            ko: "Hollo란?",
            ja: "Holloとは？",
            "zh-CN": "什么是 Hollo？",
          },
        },
        {
          label: "Installation",
          translations: {
            ko: "설치",
            ja: "インストール",
            "zh-CN": "安装",
          },
          items: [
            {
              label: "Deploy to Railway",
              translations: {
                ko: "Railway에 배포",
                ja: "Railwayにデプロイ",
                "zh-CN": "部署到 Railway",
              },
              slug: "install/railway",
            },
            {
              label: "Deploy using Docker",
              translations: {
                ko: "Docker로 배포",
                ja: "Dockerでデプロイ",
                "zh-CN": "使用 Docker 部署",
              },
              slug: "install/docker",
            },
            {
              label: "Manual installation",
              translations: {
                ko: "수동 설치",
                ja: "手動インストール",
                "zh-CN": "手动安装",
              },
              slug: "install/manual",
            },
            {
              label: "Environment variables",
              translations: {
                ko: "환경 변수",
                ja: "環境変数",
                "zh-CN": "环境变量",
              },
              slug: "install/env",
            },
            {
              label: "Setting up",
              translations: {
                ko: "설정하기",
                ja: "初期設定",
                "zh-CN": "配置指南",
              },
              slug: "install/setup",
            },
          ],
        },
        {
          slug: "clients",
          label: "Tested clients",
          translations: {
            ko: "테스트된 클라이언트",
            ja: "テスト済みクライアント",
            "zh-CN": "已测试客户端",
          },
        },
        {
          slug: "search",
          label: "Search",
          translations: {
            ko: "검색",
            ja: "検索",
            "zh-CN": "搜索",
          },
        },
      ],
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon.svg",
            media: "(prefers-color-scheme: light)",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon-darkmode.svg",
            media: "(prefers-color-scheme: dark)",
          },
        },
        ...(process.env.PLAUSIBLE_DOMAIN == null
          ? []
          : [
              {
                tag: "script",
                attrs: {
                  defer: true,
                  "data-domain": process.env.PLAUSIBLE_DOMAIN,
                  src: "https://plausible.io/js/script.outbound-links.js",
                },
              },
            ]),
      ],
    }),
  ],
});
