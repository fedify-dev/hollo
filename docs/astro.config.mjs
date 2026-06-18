import starlight from "@astrojs/starlight";
// @ts-check
import { defineConfig } from "astro/config";
import icon from "astro-icon";

// https://astro.build/config
export default defineConfig({
  site: "https://docs.hollo.social",
  integrations: [
    icon(),
    starlight({
      components: {
        SocialIcons: "./src/components/SocialIcons.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      title: "Hollo",
      logo: {
        dark: "./src/assets/logo-white.svg",
        light: "./src/assets/logo-black.svg",
        replacesTitle: true,
      },
      customCss: ["./src/styles/fonts.css", "./src/styles/custom.css"],
      social: [
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
        "zh-tw": {
          label: "繁體中文",
          lang: "zh-TW",
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
            "zh-TW": "什麼是 Hollo？",
          },
        },
        {
          label: "Installation",
          translations: {
            ko: "설치",
            ja: "インストール",
            "zh-CN": "安装",
            "zh-TW": "安裝",
          },
          items: [
            {
              label: "Deploy to Railway",
              translations: {
                ko: "Railway에 배포",
                ja: "Railwayにデプロイ",
                "zh-CN": "部署到 Railway",
                "zh-TW": "部署到 Railway",
              },
              slug: "install/railway",
            },
            {
              label: "Deploy using Docker",
              translations: {
                ko: "Docker로 배포",
                ja: "Dockerでデプロイ",
                "zh-CN": "使用 Docker 部署",
                "zh-TW": "使用 Docker 部署",
              },
              slug: "install/docker",
            },
            {
              label: "Manual installation",
              translations: {
                ko: "수동 설치",
                ja: "手動インストール",
                "zh-CN": "手动安装",
                "zh-TW": "手動安裝",
              },
              slug: "install/manual",
            },
            {
              label: "Environment variables",
              translations: {
                ko: "환경 변수",
                ja: "環境変数",
                "zh-CN": "环境变量",
                "zh-TW": "環境變數",
              },
              slug: "install/env",
            },
            {
              label: "Separating worker nodes",
              translations: {
                ko: "워커 노드 분리",
                ja: "ワーカーノードの分離",
                "zh-CN": "分离工作节点",
                "zh-TW": "分離工作節點",
              },
              slug: "install/workers",
            },
            {
              label: "Split-domain WebFinger",
              translations: {
                ko: "도메인 분리 WebFinger",
                ja: "ドメイン分離 WebFinger",
                "zh-CN": "分域 WebFinger",
                "zh-TW": "分域 WebFinger",
              },
              slug: "install/split-domain",
            },
            {
              label: "Setting up",
              translations: {
                ko: "설정하기",
                ja: "初期設定",
                "zh-CN": "配置指南",
                "zh-TW": "初始設定",
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
            "zh-TW": "已測試的客戶端",
          },
        },
        {
          slug: "search",
          label: "Search",
          translations: {
            ko: "검색",
            ja: "検索",
            "zh-CN": "搜索",
            "zh-TW": "搜尋",
          },
        },
      ],
      head: [
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.bunny.net",
            crossorigin: true,
          },
        },
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
