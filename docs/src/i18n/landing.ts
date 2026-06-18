/**
 * Copy and structure for the Hollo landing page (the docs site's splash page,
 * which doubles as the official website).
 *
 * Locale-independent structure (Lucide icon names, internal/external hrefs, the
 * federation platform list, the install steps) lives in the constants below;
 * per-locale text lives in {@link COPY}.  {@link getLanding} merges the two into
 * the {@link Landing} shape that the components in
 * ../components/landing/ consume.  The strict {@link LocaleCopy} interface makes
 * a missing translation a compile error under `astro check`.
 *
 * NOTE FOR TRANSLATION REVIEW: the English and Korean copy is authored by a
 * fluent speaker; the Japanese, Simplified Chinese, and Traditional Chinese
 * copy is a first pass that should be reviewed by a native speaker before
 * release.  Terminology follows the existing per-locale docs (e.g. ko 연합우주
 * /에모지 리액션/게시물, ja フェディバース/絵文字リアクション/投稿, zh-cn
 * 联邦宇宙/贴文, zh-tw 聯邦宇宙/貼文).
 */

export type Locale = "en" | "ko" | "ja" | "zh-cn" | "zh-tw";

export const LOCALES: readonly Locale[] = ["en", "ko", "ja", "zh-cn", "zh-tw"];

export interface Action {
  text: string;
  href: string;
  external: boolean;
}

export interface Feature {
  icon: string;
  title: string;
  body: string;
  /** Optional link to a related docs page; when set, the whole card links. */
  link?: Action;
}

export interface Platform {
  name: string;
  href: string;
}

export interface FeatureSection {
  id: string;
  eyebrow: string;
  heading: string;
  intro?: string;
  features: Feature[];
  link?: Action;
}

export interface Step {
  icon: string;
  title: string;
  body: string;
  href: string;
}

/** The merged shape consumed by the landing components. */
export interface Landing {
  hero: {
    tagline: string;
    subhead: string;
    meta: string;
    primary: Action;
    secondary: Action;
    tertiary: Action;
  };
  about: { eyebrow: string; heading: string; body: string[] };
  federation: {
    eyebrow: string;
    heading: string;
    body: string;
    platformsLabel: string;
    platforms: Platform[];
  };
  sections: FeatureSection[];
  fedify: { eyebrow: string; heading: string; body: string; link: Action };
  getStarted: {
    eyebrow: string;
    heading: string;
    intro: string;
    steps: Step[];
  };
  closing: {
    heading: string;
    body: string;
    primary: Action;
    secondary: Action;
  };
}

// ---------------------------------------------------------------------------
// Locale-independent structure
// ---------------------------------------------------------------------------

type SectionId =
  | "posting"
  | "clients"
  | "security"
  | "customization"
  | "search"
  | "ops";

const SECTION_ORDER: readonly SectionId[] = [
  "posting",
  "clients",
  "security",
  "customization",
  "search",
  "ops",
];

const SECTION_ICONS: Record<SectionId, string[]> = {
  posting: ["lucide:file-text", "lucide:quote", "lucide:smile-plus", "lucide:vote"],
  clients: ["lucide:plug", "lucide:smartphone", "lucide:key-round"],
  security: [
    "lucide:users",
    "lucide:fingerprint",
    "lucide:shield-check",
    "lucide:lock",
  ],
  customization: ["lucide:palette", "lucide:id-card", "lucide:moon", "lucide:at-sign"],
  search: ["lucide:search", "lucide:filter"],
  ops: ["lucide:hard-drive", "lucide:image-down", "lucide:server", "lucide:import"],
};

/** Sections that carry a "learn more" link to a docs page. */
const SECTION_LINKS: Partial<Record<SectionId, string>> = {
  clients: "/clients",
  search: "/search",
};

/**
 * Per-feature links to a related docs page, parallel to SECTION_ICONS (null =
 * no link for that feature).  Anchors use code-based heading IDs (e.g.
 * #drive_disk) which are stable across locales, unlike translated section
 * headings.
 */
const SECTION_FEATURE_LINKS: Partial<Record<SectionId, (string | null)[]>> = {
  customization: [null, null, null, "/install/split-domain/"],
  ops: [
    "/install/env/#drive_disk",
    "/install/env/#media_proxy-",
    "/install/workers/",
    null,
  ],
};

const STEP_ICONS = ["lucide:train-front", "lucide:container", "lucide:terminal"];
const STEP_HREFS = ["/install/railway", "/install/docker", "/install/manual"];

const PLATFORMS: Platform[] = [
  { name: "Mastodon", href: "https://joinmastodon.org/" },
  { name: "Misskey", href: "https://misskey-hub.net/" },
  { name: "Akkoma", href: "https://akkoma.social/" },
  { name: "WordPress", href: "https://wordpress.org/" },
  { name: "Threads", href: "https://www.threads.net/" },
];

const HREF_INSTALL = "/install/docker";
const HREF_INTRO = "/intro";
const EXTERNAL_INSTANCE = "https://hollo.social/@hollo";
const EXTERNAL_FEDIFY = "https://fedify.dev/";
const EXTERNAL_GITHUB = "https://github.com/fedify-dev/hollo";

// ---------------------------------------------------------------------------
// Per-locale copy
// ---------------------------------------------------------------------------

interface SectionText {
  eyebrow: string;
  heading: string;
  intro?: string;
  linkText?: string;
  features: { title: string; body: string }[];
}

interface LocaleCopy {
  hero: {
    tagline: string;
    subhead: string;
    meta: string;
    primaryText: string;
    secondaryText: string;
    tertiaryText: string;
  };
  about: { eyebrow: string; heading: string; body: string[] };
  federation: {
    eyebrow: string;
    heading: string;
    body: string;
    platformsLabel: string;
  };
  sections: Record<SectionId, SectionText>;
  fedify: { eyebrow: string; heading: string; body: string; linkText: string };
  getStarted: {
    eyebrow: string;
    heading: string;
    intro: string;
    steps: { title: string; body: string }[];
  };
  closing: {
    heading: string;
    body: string;
    primaryText: string;
    secondaryText: string;
  };
}

const COPY: Record<Locale, LocaleCopy> = {
  en: {
    hero: {
      tagline: "A single-user microblogging server for the fediverse.",
      subhead:
        "Hollo speaks ActivityPub, exposes a Mastodon-compatible API, and writes in CommonMark. Run your own corner of the social web and reach it from the client you already like.",
      meta: "Free, open source, and self-hosted · AGPL-3.0",
      primaryText: "Install Hollo",
      secondaryText: "What is Hollo?",
      tertiaryText: "See the official instance",
    },
    about: {
      eyebrow: "What is Hollo",
      heading: "Your own corner of the fediverse",
      body: [
        "Hollo is a microblogging server for one person. You host it yourself, keep your data, and publish under your own domain. There is no shared instance, and no one else's moderation queue to run.",
        "It is headless: instead of bundling a web interface, it implements Mastodon-compatible APIs, so you read and write through whichever Mastodon client suits you.",
        "The name comes from the Korean word 홀로 (hollo), meaning alone. It is a fitting name for software built for a single person.",
      ],
    },
    federation: {
      eyebrow: "Federation",
      heading: "Connected by ActivityPub",
      body: "Hollo implements the ActivityPub protocol, so it joins the wider social web instead of locking you into one network. Follow and be followed across servers, reply across platforms, and keep your audience as you move.",
      platformsLabel: "Interoperates with",
    },
    sections: {
      posting: {
        eyebrow: "Posting",
        heading: "More than a status line",
        intro:
          "Write the way you want, and quote, react, and poll like the rest of the fediverse.",
        features: [
          {
            title: "CommonMark formatting",
            body: "Compose posts in CommonMark (Markdown). Hollo renders them, and so does the rest of the fediverse. Each post can run up to 10,000 characters.",
          },
          {
            title: "Quote posts",
            body: "Quote other posts with FEP-044f-compliant quotes, compatible with Misskey- and Mastodon-style implementations. Quote-authorization policies decide who may quote you.",
          },
          {
            title: "Emoji reactions",
            body: "React with Unicode or custom emoji, Misskey-style, and upload custom emoji of your own.",
          },
          {
            title: "Polls, media, and tags",
            body: "Run polls, attach images, video, and audio, and use hashtags and mentions like any other microblog.",
          },
        ],
      },
      clients: {
        eyebrow: "Clients",
        heading: "Use the app you already like",
        intro:
          "Hollo has no web app of its own. It speaks the Mastodon API, so pick a client and go.",
        linkText: "See tested clients",
        features: [
          {
            title: "Mastodon-compatible API",
            body: "A Mastodon-compatible REST API (v1 and v2) stands in for a built-in interface, so existing clients just work.",
          },
          {
            title: "Any Mastodon client",
            body: "Connect with the Mastodon app you prefer. Phanpy and others are listed on the tested-clients page.",
          },
          {
            title: "OAuth apps",
            body: "Authorize apps through a standard OAuth 2.0 consent screen and manage their access.",
          },
        ],
      },
      security: {
        eyebrow: "Accounts & security",
        heading: "One server, locked down",
        features: [
          {
            title: "Single user, multiple accounts",
            body: "Built for one person, but you can host several of your own accounts on one instance and switch between them.",
          },
          {
            title: "Passkeys",
            body: "Sign in with passkeys (WebAuthn), either device-bound or synced, alongside a password.",
          },
          {
            title: "Two-factor authentication",
            body: "Add time-based one-time-password (TOTP) two-factor authentication.",
          },
          {
            title: "OAuth 2.0 and CSRF protection",
            body: "OAuth 2.0 with PKCE for clients, and CSRF protection on every cookie-authenticated route.",
          },
        ],
      },
      customization: {
        eyebrow: "Customization",
        heading: "Make it yours",
        features: [
          {
            title: "Theme colors",
            body: "Choose from twenty theme colors to tint your profile and posts.",
          },
          {
            title: "Profile fields",
            body: "Add custom profile fields with Markdown, plus an avatar and header image.",
          },
          {
            title: "Automatic dark mode",
            body: "Light and dark themes follow each visitor's system preference.",
          },
          {
            title: "Your own handle domain",
            body: "Keep your handle on one domain while the server runs on another, using split-domain WebFinger (for example, <code>@you@example.com</code> served from <code>ap.example.com</code>).",
          },
        ],
      },
      search: {
        eyebrow: "Search",
        heading: "Find it with operators",
        intro: "Search across your posts with a query language, not just keywords.",
        linkText: "Read the search guide",
        features: [
          {
            title: "Filter operators",
            body: "Narrow results with <code>has:media</code>, <code>has:poll</code>, <code>is:reply</code>, <code>is:sensitive</code>, <code>from:</code>, <code>mentions:</code>, <code>language:</code>, and <code>before:</code>/<code>after:</code> dates.",
          },
          {
            title: "Boolean queries",
            body: "Combine terms with <code>AND</code>, <code>OR</code>, negation (<code>-</code>), parentheses, and quoted phrases.",
          },
        ],
      },
      ops: {
        eyebrow: "Self-hosting",
        heading: "Runs where you do",
        intro:
          "Hollo fits a range of self-hosting setups.",
        features: [
          {
            title: "Flexible storage",
            body: "Keep media on the local filesystem or any S3-compatible object storage.",
          },
          {
            title: "Media proxy",
            body: "Optionally proxy or cache remote avatars, images, and emoji through your own origin for privacy.",
          },
          {
            title: "Worker separation",
            body: "Split web and worker processes to scale background jobs independently.",
          },
          {
            title: "Data import",
            body: "Bring your follows, lists, mutes, blocks, and bookmarks from a Mastodon or Iceshrimp export.",
          },
        ],
      },
    },
    fedify: {
      eyebrow: "Foundations",
      heading: "Powered by Fedify",
      body: "Hollo is built on Fedify, an ActivityPub server framework for TypeScript. Fedify handles the hard parts of federation, such as HTTP Signatures, object integrity proofs, WebFinger, and NodeInfo, so Hollo can focus on being a good microblog.",
      linkText: "Learn about Fedify",
    },
    getStarted: {
      eyebrow: "Get started",
      heading: "Install Hollo your way",
      intro:
        "Hollo needs PostgreSQL and somewhere to store media. Pick the path that fits you.",
      steps: [
        {
          title: "Deploy to Railway",
          body: "One-click deploy with managed PostgreSQL.",
        },
        { title: "Run with Docker", body: "Use the published image with Docker Compose." },
        {
          title: "Install manually",
          body: "Run from source with Node.js and pnpm.",
        },
      ],
    },
    closing: {
      heading: "Run your own corner of the fediverse",
      body: "Hollo is free, open source, and yours to host.",
      primaryText: "Install Hollo",
      secondaryText: "View source on GitHub",
    },
  },

  ko: {
    hero: {
      tagline: "연합우주를 위한 1인용 마이크로블로그 서버.",
      subhead:
        "Hollo는 ActivityPub로 연합하고, Mastodon 호환 API를 제공하며, CommonMark로 글을 씁니다. 나만의 연합우주 공간을 직접 운영하고, 평소 쓰던 클라이언트로 드나드세요.",
      meta: "무료, 오픈 소스, 셀프 호스팅 · AGPL-3.0",
      primaryText: "Hollo 설치하기",
      secondaryText: "Hollo란?",
      tertiaryText: "공식 인스턴스 보기",
    },
    about: {
      eyebrow: "Hollo란",
      heading: "연합우주 속 나만의 공간",
      body: [
        "Hollo는 한 사람을 위한 마이크로블로그 서버입니다. 직접 호스팅하고, 데이터를 스스로 보관하며, 자신의 도메인으로 게시합니다. 공용 인스턴스도, 남의 신고를 처리할 운영 업무도 없습니다.",
        "Hollo는 헤드리스입니다. 자체 웹 인터페이스를 갖추는 대신 Mastodon 호환 API를 구현하므로, 자신에게 맞는 Mastodon 클라이언트로 읽고 씁니다.",
        "이름은 ‘혼자’를 뜻하는 우리말 홀로에서 따왔습니다. 한 사람을 위해 만든 소프트웨어에 어울리는 이름입니다.",
      ],
    },
    federation: {
      eyebrow: "연합",
      heading: "ActivityPub로 연결됩니다",
      body: "Hollo는 ActivityPub 프로토콜을 구현하므로, 하나의 네트워크에 갇히지 않고 더 넓은 소셜 웹에 참여합니다. 서버를 넘나들며 팔로우하고 팔로우받으며, 플랫폼을 가로질러 답글을 달고, 어디로 옮기든 독자를 그대로 데려갑니다.",
      platformsLabel: "이런 소프트웨어와 호환됩니다",
    },
    sections: {
      posting: {
        eyebrow: "게시",
        heading: "한 줄 상태글, 그 이상",
        intro:
          "원하는 방식으로 글을 쓰고, 연합우주의 다른 곳처럼 인용하고 리액션하고 투표하세요.",
        features: [
          {
            title: "CommonMark 서식",
            body: "CommonMark(Markdown)로 게시물을 작성합니다. Hollo가 렌더링하고, 연합우주의 다른 소프트웨어도 마찬가지입니다. 게시물 당 최대 10,000자까지 쓸 수 있습니다.",
          },
          {
            title: "인용 게시물",
            body: "FEP-044f를 준수하는 인용으로 다른 게시물을 인용합니다. Misskey 스타일과 Mastodon 스타일 모두와 호환되며, 인용 허가 정책으로 누가 나를 인용할 수 있는지 정합니다.",
          },
          {
            title: "에모지 리액션",
            body: "Misskey 스타일로 Unicode 에모지나 커스텀 에모지를 달아 리액션하고, 나만의 커스텀 에모지를 올릴 수 있습니다.",
          },
          {
            title: "투표, 미디어, 태그",
            body: "투표를 올리고, 이미지·동영상·오디오를 첨부하며, 다른 마이크로블로그처럼 해시태그와 멘션을 씁니다.",
          },
        ],
      },
      clients: {
        eyebrow: "클라이언트",
        heading: "쓰던 앱을 그대로",
        intro:
          "Hollo에는 자체 웹 앱이 없습니다. Mastodon API를 따르므로 원하는 클라이언트를 골라 바로 시작하세요.",
        linkText: "테스트된 클라이언트 보기",
        features: [
          {
            title: "Mastodon 호환 API",
            body: "내장 인터페이스 대신 Mastodon 호환 REST API(v1·v2)를 제공하므로 기존 클라이언트가 그대로 동작합니다.",
          },
          {
            title: "모든 Mastodon 클라이언트",
            body: "원하는 Mastodon 앱으로 접속하세요. Phanpy를 비롯한 여러 앱을 테스트된 클라이언트 페이지에 정리해 두었습니다.",
          },
          {
            title: "OAuth 앱",
            body: "표준 OAuth 2.0 동의 화면으로 앱을 인가하고 접근 권한을 관리합니다.",
          },
        ],
      },
      security: {
        eyebrow: "계정과 보안",
        heading: "하나의 서버, 단단한 잠금",
        features: [
          {
            title: "1인 사용자, 다중 계정",
            body: "한 사람을 위해 만들었지만, 한 인스턴스에서 자신의 계정 여럿을 운영하고 그 사이를 전환할 수 있습니다.",
          },
          {
            title: "패스키",
            body: "비밀번호와 더불어, 기기에 묶이거나 동기화되는 패스키(WebAuthn)로 로그인합니다.",
          },
          {
            title: "2단계 인증",
            body: "시간 기반 일회용 비밀번호(TOTP) 2단계 인증을 더할 수 있습니다.",
          },
          {
            title: "OAuth 2.0과 CSRF 보호",
            body: "클라이언트를 위한 PKCE 기반 OAuth 2.0과, 쿠키로 인증되는 모든 경로에 대한 CSRF 보호를 갖췄습니다.",
          },
        ],
      },
      customization: {
        eyebrow: "꾸미기",
        heading: "나답게",
        features: [
          {
            title: "테마 색상",
            body: "스무 가지 테마 색상 중에서 골라 프로필과 게시물에 색을 입힙니다.",
          },
          {
            title: "프로필 항목",
            body: "Markdown을 쓰는 커스텀 프로필 항목과 아바타·헤더 이미지를 더합니다.",
          },
          {
            title: "자동 다크 모드",
            body: "밝은 테마와 어두운 테마가 방문자의 시스템 설정을 따릅니다.",
          },
          {
            title: "나만의 핸들 도메인",
            body: "도메인 분리 WebFinger로, 서버는 한 도메인에서 돌리면서 핸들은 다른 도메인으로 쓸 수 있습니다(예: <code>@you@example.com</code>을 <code>ap.example.com</code>에서 제공).",
          },
        ],
      },
      search: {
        eyebrow: "검색",
        heading: "연산자로 찾기",
        intro: "키워드를 넘어, 질의 언어로 내 게시물을 검색합니다.",
        linkText: "검색 안내 읽기",
        features: [
          {
            title: "필터 연산자",
            body: "<code>has:media</code>, <code>has:poll</code>, <code>is:reply</code>, <code>is:sensitive</code>, <code>from:</code>, <code>mentions:</code>, <code>language:</code>, 그리고 <code>before:</code>/<code>after:</code> 날짜로 결과를 좁힙니다.",
          },
          {
            title: "불리언 질의",
            body: "<code>AND</code>, <code>OR</code>, 부정(<code>-</code>), 괄호, 따옴표로 묶은 구문으로 검색어를 조합합니다.",
          },
        ],
      },
      ops: {
        eyebrow: "셀프 호스팅",
        heading: "당신이 있는 곳에서 돌아갑니다",
        intro:
          "Hollo는 다양한 셀프 호스팅 구성에 맞습니다.",
        features: [
          {
            title: "유연한 저장소",
            body: "미디어를 로컬 파일시스템이나 S3 호환 오브젝트 스토리지에 보관합니다.",
          },
          {
            title: "미디어 프록시",
            body: "원격 아바타·이미지·에모지를 자신의 출처를 통해 프록시하거나 캐시하여 프라이버시를 지킬 수 있습니다.",
          },
          {
            title: "워커 분리",
            body: "웹 프로세스와 워커 프로세스를 나눠 백그라운드 작업을 따로 확장합니다.",
          },
          {
            title: "데이터 가져오기",
            body: "Mastodon이나 Iceshrimp 내보내기 파일에서 팔로우·리스트·뮤트·차단·북마크를 가져옵니다.",
          },
        ],
      },
    },
    fedify: {
      eyebrow: "토대",
      heading: "Fedify로 제작됨",
      body: "Hollo는 TypeScript를 위한 ActivityPub 서버 프레임워크 Fedify로 만들어졌습니다. HTTP 서명, 객체 무결성 증명, WebFinger, NodeInfo 같은 연합의 까다로운 부분을 Fedify가 맡아 주기에, Hollo는 좋은 마이크로블로그가 되는 데 집중합니다.",
      linkText: "Fedify 알아보기",
    },
    getStarted: {
      eyebrow: "시작하기",
      heading: "원하는 방식으로 Hollo 설치하기",
      intro:
        "Hollo에는 PostgreSQL과 미디어를 저장할 공간이 필요합니다. 자신에게 맞는 길을 고르세요.",
      steps: [
        { title: "Railway에 배포", body: "관리형 PostgreSQL과 함께 원클릭으로 배포합니다." },
        { title: "Docker로 실행", body: "공개된 이미지를 Docker Compose로 띄웁니다." },
        { title: "수동 설치", body: "Node.js와 pnpm으로 소스에서 직접 실행합니다." },
      ],
    },
    closing: {
      heading: "연합우주 속 나만의 공간을 직접 운영하세요",
      body: "Hollo는 무료이고 오픈 소스이며, 직접 호스팅할 수 있습니다.",
      primaryText: "Hollo 설치하기",
      secondaryText: "GitHub에서 소스 보기",
    },
  },

  ja: {
    hero: {
      tagline: "フェディバースのための一人様向けマイクロブログサーバー。",
      subhead:
        "HolloはActivityPubで連合し、Mastodon互換APIを提供し、CommonMarkで書けます。自分だけのフェディバースの拠点を運営し、使い慣れたクライアントから出入りしましょう。",
      meta: "無料・オープンソース・セルフホスト · AGPL-3.0",
      primaryText: "Holloをインストール",
      secondaryText: "Holloとは？",
      tertiaryText: "公式インスタンスを見る",
    },
    about: {
      eyebrow: "Holloとは",
      heading: "フェディバースにある自分だけの拠点",
      body: [
        "Holloは一人様向けのマイクロブログサーバーです。自分でホスティングし、データを手元に保ち、自分のドメインで発信します。共用インスタンスも、他人の通報を捌く運用もありません。",
        "Holloはヘッドレスです。独自のウェブインターフェースを持たず、Mastodon互換APIを実装しているので、自分に合ったMastodonクライアントで読み書きします。",
        "名前は「ひとり」を意味する韓国語の홀로（ホルロ）に由来します。一人様向けに作られたソフトウェアにふさわしい名前です。",
      ],
    },
    federation: {
      eyebrow: "連合",
      heading: "ActivityPubでつながる",
      body: "HolloはActivityPubプロトコルを実装しているため、1つのネットワークに閉じ込められることなく、より広いソーシャルウェブに加わります。サーバーを越えてフォローし、フォローされ、プラットフォームをまたいで返信し、どこへ移っても読者を連れていけます。",
      platformsLabel: "次のソフトウェアと相互運用できます",
    },
    sections: {
      posting: {
        eyebrow: "投稿",
        heading: "ひと言ステータス以上のもの",
        intro:
          "好きなように書き、フェディバースの他の場所と同じように引用し、リアクションし、投票できます。",
        features: [
          {
            title: "CommonMark書式",
            body: "CommonMark（Markdown）で投稿を書けます。Holloがレンダリングし、フェディバースの他のソフトウェアでも同様です。1投稿あたり最大10,000文字まで書けます。",
          },
          {
            title: "引用投稿",
            body: "FEP-044f準拠の引用で他の投稿を引用できます。MisskeyスタイルとMastodonスタイルの両方に対応し、引用の許可ポリシーで誰が自分を引用できるかを決められます。",
          },
          {
            title: "絵文字リアクション",
            body: "Misskeyスタイルで、Unicode絵文字やカスタム絵文字を付けてリアクションでき、自分のカスタム絵文字をアップロードできます。",
          },
          {
            title: "投票・メディア・タグ",
            body: "投票を作成し、画像・動画・音声を添付し、他のマイクロブログと同じようにハッシュタグやメンションを使えます。",
          },
        ],
      },
      clients: {
        eyebrow: "クライアント",
        heading: "使い慣れたアプリのままで",
        intro:
          "Holloには独自のウェブアプリがありません。Mastodon APIに準拠しているので、好きなクライアントを選んですぐ始められます。",
        linkText: "テスト済みクライアントを見る",
        features: [
          {
            title: "Mastodon互換API",
            body: "組み込みのインターフェースの代わりにMastodon互換のREST API（v1・v2）を備えているので、既存のクライアントがそのまま動きます。",
          },
          {
            title: "あらゆるMastodonクライアント",
            body: "好みのMastodonアプリで接続できます。Phanpyをはじめ、テスト済みクライアントのページに掲載しています。",
          },
          {
            title: "OAuthアプリ",
            body: "標準的なOAuth 2.0の同意画面でアプリを認可し、アクセス権を管理します。",
          },
        ],
      },
      security: {
        eyebrow: "アカウントとセキュリティ",
        heading: "1つのサーバーを、しっかり施錠",
        features: [
          {
            title: "一人様向け、複数アカウント",
            body: "一人様向けに作られていますが、1つのインスタンスで自分のアカウントを複数運用し、切り替えられます。",
          },
          {
            title: "パスキー",
            body: "パスワードに加えて、端末に紐づくまたは同期されるパスキー（WebAuthn）でサインインできます。",
          },
          {
            title: "二要素認証",
            body: "時間ベースのワンタイムパスワード（TOTP）による二要素認証を追加できます。",
          },
          {
            title: "OAuth 2.0とCSRF保護",
            body: "クライアント向けのPKCE対応OAuth 2.0と、Cookie認証を使うすべての経路へのCSRF保護を備えています。",
          },
        ],
      },
      customization: {
        eyebrow: "カスタマイズ",
        heading: "自分らしく",
        features: [
          {
            title: "テーマカラー",
            body: "20種類のテーマカラーから選んで、プロフィールや投稿に色を付けられます。",
          },
          {
            title: "プロフィール項目",
            body: "Markdownが使えるカスタムプロフィール項目に加えて、アバターやヘッダー画像を設定できます。",
          },
          {
            title: "自動ダークモード",
            body: "ライトテーマとダークテーマが、訪問者のシステム設定に従います。",
          },
          {
            title: "自分だけのハンドルのドメイン",
            body: "ドメイン分離WebFingerにより、サーバーを一方のドメインで動かしつつ、ハンドルを別のドメインにできます（例: <code>@you@example.com</code> を <code>ap.example.com</code> から提供）。",
          },
        ],
      },
      search: {
        eyebrow: "検索",
        heading: "演算子で見つける",
        intro: "キーワードだけでなく、クエリ言語で自分の投稿を検索できます。",
        linkText: "検索ガイドを読む",
        features: [
          {
            title: "フィルター演算子",
            body: "<code>has:media</code>、<code>has:poll</code>、<code>is:reply</code>、<code>is:sensitive</code>、<code>from:</code>、<code>mentions:</code>、<code>language:</code>、そして<code>before:</code>/<code>after:</code>の日付で結果を絞り込めます。",
          },
          {
            title: "ブール検索",
            body: "<code>AND</code>、<code>OR</code>、否定（<code>-</code>）、括弧、引用符で囲んだフレーズで検索語を組み合わせられます。",
          },
        ],
      },
      ops: {
        eyebrow: "セルフホスティング",
        heading: "あなたのいる場所で動く",
        intro:
          "Holloはさまざまなセルフホスティング構成に対応します。",
        features: [
          {
            title: "柔軟なストレージ",
            body: "メディアをローカルファイルシステムや、S3互換のオブジェクトストレージに保存できます。",
          },
          {
            title: "メディアプロキシ",
            body: "リモートのアバター・画像・絵文字を自分のオリジン経由でプロキシまたはキャッシュし、プライバシーを守れます。",
          },
          {
            title: "ワーカーの分離",
            body: "ウェブプロセスとワーカープロセスを分け、バックグラウンド処理を独立してスケールできます。",
          },
          {
            title: "データインポート",
            body: "MastodonやIceshrimpのエクスポートから、フォロー・リスト・ミュート・ブロック・ブックマークを取り込めます。",
          },
        ],
      },
    },
    fedify: {
      eyebrow: "土台",
      heading: "Fedifyベース",
      body: "HolloはTypeScript向けのActivityPubサーバーフレームワークFedifyで作られています。HTTP署名、オブジェクト整合性証明、WebFinger、NodeInfoといった連合の難しい部分をFedifyが引き受けるので、Holloは良いマイクロブログであることに専念できます。",
      linkText: "Fedifyについて知る",
    },
    getStarted: {
      eyebrow: "はじめる",
      heading: "好きな方法でHolloをインストール",
      intro:
        "HolloにはPostgreSQLと、メディアを保存する場所が必要です。自分に合った方法を選んでください。",
      steps: [
        { title: "Railwayにデプロイ", body: "マネージドのPostgreSQLとともにワンクリックでデプロイ。" },
        { title: "Dockerで実行", body: "公開イメージをDocker Composeで起動。" },
        { title: "手動インストール", body: "Node.jsとpnpmでソースから実行。" },
      ],
    },
    closing: {
      heading: "フェディバースの自分だけの拠点を運営しよう",
      body: "Holloは無料でオープンソース、自分でホスティングできます。",
      primaryText: "Holloをインストール",
      secondaryText: "GitHubでソースを見る",
    },
  },

  "zh-cn": {
    hero: {
      tagline: "面向单用户的联邦宇宙微博服务器。",
      subhead:
        "Hollo 通过 ActivityPub 联邦互通，提供兼容 Mastodon 的 API，并以 CommonMark 书写。运营属于你自己的联邦宇宙一隅，用你惯用的客户端随时访问。",
      meta: "免费、开源、自托管 · AGPL-3.0",
      primaryText: "安装 Hollo",
      secondaryText: "什么是 Hollo？",
      tertiaryText: "查看官方实例",
    },
    about: {
      eyebrow: "什么是 Hollo",
      heading: "联邦宇宙中属于你的一隅",
      body: [
        "Hollo 是一款面向一个人的微博服务器。你自行托管、自己保管数据，并在自己的域名下发布。没有公共实例，也没有别人的举报队列要处理。",
        "Hollo 是无头的：它不内置网页界面，而是实现兼容 Mastodon 的 API，因此你可以用合适的 Mastodon 客户端来阅读和发布。",
        "它的名字取自韩语 홀로（hollo），意为“独自”，很适合一款为单个用户打造的软件。",
      ],
    },
    federation: {
      eyebrow: "联邦",
      heading: "由 ActivityPub 连接",
      body: "Hollo 实现了 ActivityPub 协议，因此它融入更广阔的社交网络，而不会把你锁定在单一网络中。跨服务器关注与被关注，跨平台回复，无论迁移到哪里都能带走你的读者。",
      platformsLabel: "可与以下软件互通",
    },
    sections: {
      posting: {
        eyebrow: "发布",
        heading: "不止一行状态",
        intro: "按你喜欢的方式书写，并像联邦宇宙的其他地方一样引用、回应和发起投票。",
        features: [
          {
            title: "CommonMark 格式",
            body: "用 CommonMark（Markdown）撰写贴文。Hollo 会为你呈现，联邦宇宙的其他软件也会呈现。每条贴文最多 10,000 个字符。",
          },
          {
            title: "引用贴文",
            body: "用符合 FEP-044f 标准的引用来引用其他贴文，同时兼容 Misskey 风格和 Mastodon 风格；引用授权策略可决定谁能引用你。",
          },
          {
            title: "表情回应",
            body: "以 Misskey 风格用 Unicode 表情或自定义表情进行回应，还能上传你自己的自定义表情。",
          },
          {
            title: "投票、媒体与标签",
            body: "发起投票，附带图片、视频和音频，并像其他微博一样使用话题标签和提及。",
          },
        ],
      },
      clients: {
        eyebrow: "客户端",
        heading: "继续用你喜欢的应用",
        intro: "Hollo 没有自己的网页应用。它遵循 Mastodon API，挑一个客户端即可开始。",
        linkText: "查看已测试客户端",
        features: [
          {
            title: "兼容 Mastodon 的 API",
            body: "用兼容 Mastodon 的 REST API（v1 和 v2）取代内置界面，现有客户端开箱即用。",
          },
          {
            title: "任意 Mastodon 客户端",
            body: "用你偏好的 Mastodon 应用连接。Phanpy 等已列在“已测试客户端”页面。",
          },
          {
            title: "OAuth 应用",
            body: "通过标准的 OAuth 2.0 授权页面授权应用，并管理其访问权限。",
          },
        ],
      },
      security: {
        eyebrow: "账户与安全",
        heading: "一台服务器，牢牢锁好",
        features: [
          {
            title: "单用户，多账户",
            body: "虽为一个人而设计，但你可以在同一实例上运营自己的多个账户，并在它们之间切换。",
          },
          {
            title: "通行密钥",
            body: "除密码外，还可用通行密钥（WebAuthn）登录，支持设备绑定或同步。",
          },
          {
            title: "两步验证",
            body: "可添加基于时间的一次性密码（TOTP）两步验证。",
          },
          {
            title: "OAuth 2.0 与 CSRF 防护",
            body: "为客户端提供带 PKCE 的 OAuth 2.0，并对所有使用 Cookie 认证的路由进行 CSRF 防护。",
          },
        ],
      },
      customization: {
        eyebrow: "个性化",
        heading: "做你自己的样子",
        features: [
          {
            title: "主题色",
            body: "从二十种主题色中选择，为你的资料页和贴文上色。",
          },
          {
            title: "资料字段",
            body: "添加支持 Markdown 的自定义资料字段，以及头像和页头图片。",
          },
          {
            title: "自动深色模式",
            body: "浅色与深色主题会跟随访客的系统设置。",
          },
          {
            title: "属于你的用户地址域名",
            body: "借助分域 WebFinger，服务器运行在一个域名上，而用户地址可使用另一个域名（例如 <code>@you@example.com</code> 由 <code>ap.example.com</code> 提供）。",
          },
        ],
      },
      search: {
        eyebrow: "搜索",
        heading: "用运算符精确查找",
        intro: "不止关键词，用查询语言来搜索你的贴文。",
        linkText: "阅读搜索指南",
        features: [
          {
            title: "过滤运算符",
            body: "用 <code>has:media</code>、<code>has:poll</code>、<code>is:reply</code>、<code>is:sensitive</code>、<code>from:</code>、<code>mentions:</code>、<code>language:</code>，以及 <code>before:</code>/<code>after:</code> 日期来缩小结果。",
          },
          {
            title: "布尔查询",
            body: "用 <code>AND</code>、<code>OR</code>、取反（<code>-</code>）、括号和带引号的短语来组合搜索词。",
          },
        ],
      },
      ops: {
        eyebrow: "自托管",
        heading: "在你所在之处运行",
        intro:
          "Hollo 适配多种自托管部署方式。",
        features: [
          {
            title: "灵活的存储",
            body: "将媒体存放在本地文件系统，或任意兼容 S3 的对象存储中。",
          },
          {
            title: "媒体代理",
            body: "可选择通过你自己的源站代理或缓存远程头像、图片和表情，以保护隐私。",
          },
          {
            title: "工作进程分离",
            body: "拆分网页进程与工作进程，独立扩展后台任务。",
          },
          {
            title: "数据导入",
            body: "从 Mastodon 或 Iceshrimp 的导出文件中导入你的关注、列表、隐藏、屏蔽和书签。",
          },
        ],
      },
    },
    fedify: {
      eyebrow: "基石",
      heading: "由 Fedify 提供支持",
      body: "Hollo 基于 Fedify 构建，这是一个面向 TypeScript 的 ActivityPub 服务端框架。HTTP 签名、对象完整性证明、WebFinger、NodeInfo 这些联邦中的难点都交给 Fedify，Hollo 便能专注于做好一款微博。",
      linkText: "了解 Fedify",
    },
    getStarted: {
      eyebrow: "开始使用",
      heading: "按你的方式安装 Hollo",
      intro: "Hollo 需要 PostgreSQL 和一处存放媒体的空间。挑选适合你的方式。",
      steps: [
        { title: "部署到 Railway", body: "搭配托管的 PostgreSQL，一键部署。" },
        { title: "用 Docker 运行", body: "用 Docker Compose 启动已发布的镜像。" },
        { title: "手动安装", body: "用 Node.js 和 pnpm 从源码运行。" },
      ],
    },
    closing: {
      heading: "运营属于你自己的联邦宇宙一隅",
      body: "Hollo 免费、开源，并且可以自托管。",
      primaryText: "安装 Hollo",
      secondaryText: "在 GitHub 查看源代码",
    },
  },

  "zh-tw": {
    hero: {
      tagline: "面向單用戶的聯邦宇宙微博伺服器。",
      subhead:
        "Hollo 透過 ActivityPub 聯邦互通，提供相容 Mastodon 的 API，並以 CommonMark 撰寫。經營屬於你自己的聯邦宇宙一隅，用你慣用的用戶端隨時造訪。",
      meta: "免費、開源、自架 · AGPL-3.0",
      primaryText: "安裝 Hollo",
      secondaryText: "什麼是 Hollo？",
      tertiaryText: "查看官方實例",
    },
    about: {
      eyebrow: "什麼是 Hollo",
      heading: "聯邦宇宙中屬於你的一隅",
      body: [
        "Hollo 是一款面向一個人的微博伺服器。你自行架設、自己保管資料，並在自己的網域下發布。沒有公共實例，也沒有別人的檢舉佇列要處理。",
        "Hollo 是無頭的：它不內建網頁介面，而是實作相容 Mastodon 的 API，因此你可以用合適的 Mastodon 用戶端來閱讀與發布。",
        "它的名字取自韓語 홀로（hollo），意為「獨自」，很適合一款為單一使用者打造的軟體。",
      ],
    },
    federation: {
      eyebrow: "聯邦",
      heading: "以 ActivityPub 連接",
      body: "Hollo 實作了 ActivityPub 協定，因此它融入更廣闊的社群網路，而不會把你鎖在單一網路中。跨伺服器追蹤與被追蹤，跨平台回覆，無論搬到哪裡都能帶走你的讀者。",
      platformsLabel: "可與下列軟體互通",
    },
    sections: {
      posting: {
        eyebrow: "發布",
        heading: "不只一行狀態",
        intro: "依你喜歡的方式撰寫，並像聯邦宇宙的其他地方一樣引用、回應與發起投票。",
        features: [
          {
            title: "CommonMark 格式",
            body: "以 CommonMark（Markdown）撰寫貼文。Hollo 會為你呈現，聯邦宇宙的其他軟體也會呈現。每則貼文最多 10,000 個字元。",
          },
          {
            title: "引用貼文",
            body: "以符合 FEP-044f 標準的引用來引用其他貼文，同時相容 Misskey 風格與 Mastodon 風格；引用授權政策可決定誰能引用你。",
          },
          {
            title: "表情回應",
            body: "以 Misskey 風格用 Unicode 表情或自訂表情回應，還能上傳你自己的自訂表情。",
          },
          {
            title: "投票、媒體與標籤",
            body: "發起投票，附上圖片、影片與音訊，並像其他微博一樣使用主題標籤與提及。",
          },
        ],
      },
      clients: {
        eyebrow: "用戶端",
        heading: "繼續用你喜歡的應用程式",
        intro: "Hollo 沒有自己的網頁應用程式。它遵循 Mastodon API，挑一個用戶端即可開始。",
        linkText: "查看已測試的用戶端",
        features: [
          {
            title: "相容 Mastodon 的 API",
            body: "以相容 Mastodon 的 REST API（v1 與 v2）取代內建介面，現有用戶端開箱即用。",
          },
          {
            title: "任何 Mastodon 用戶端",
            body: "用你偏好的 Mastodon 應用程式連線。Phanpy 等已列在「已測試的用戶端」頁面。",
          },
          {
            title: "OAuth 應用程式",
            body: "透過標準的 OAuth 2.0 同意畫面授權應用程式，並管理其存取權限。",
          },
        ],
      },
      security: {
        eyebrow: "帳號與安全",
        heading: "一台伺服器，牢牢鎖好",
        features: [
          {
            title: "單一使用者，多帳號",
            body: "雖為一個人而設計，但你可以在同一實例上經營自己的多個帳號，並在其間切換。",
          },
          {
            title: "通行密鑰",
            body: "除了密碼，還可用通行密鑰（WebAuthn）登入，支援裝置綁定或同步。",
          },
          {
            title: "兩步驟驗證",
            body: "可加入以時間為基礎的一次性密碼（TOTP）兩步驟驗證。",
          },
          {
            title: "OAuth 2.0 與 CSRF 防護",
            body: "為用戶端提供帶 PKCE 的 OAuth 2.0，並對所有使用 Cookie 驗證的路由進行 CSRF 防護。",
          },
        ],
      },
      customization: {
        eyebrow: "個人化",
        heading: "做你自己的樣子",
        features: [
          {
            title: "主題色",
            body: "從二十種主題色中挑選，為你的個人資料頁與貼文上色。",
          },
          {
            title: "個人資料欄位",
            body: "新增支援 Markdown 的自訂個人資料欄位，以及大頭貼與頁首圖片。",
          },
          {
            title: "自動深色模式",
            body: "淺色與深色主題會跟隨訪客的系統設定。",
          },
          {
            title: "屬於你的使用者位址網域",
            body: "透過分域 WebFinger，伺服器運行在一個網域上，而使用者位址可使用另一個網域（例如 <code>@you@example.com</code> 由 <code>ap.example.com</code> 提供）。",
          },
        ],
      },
      search: {
        eyebrow: "搜尋",
        heading: "用運算子精準尋找",
        intro: "不只關鍵字，用查詢語言搜尋你的貼文。",
        linkText: "閱讀搜尋指南",
        features: [
          {
            title: "篩選運算子",
            body: "用 <code>has:media</code>、<code>has:poll</code>、<code>is:reply</code>、<code>is:sensitive</code>、<code>from:</code>、<code>mentions:</code>、<code>language:</code>，以及 <code>before:</code>/<code>after:</code> 日期縮小結果。",
          },
          {
            title: "布林查詢",
            body: "用 <code>AND</code>、<code>OR</code>、否定（<code>-</code>）、括號與引號括起的片語來組合搜尋詞。",
          },
        ],
      },
      ops: {
        eyebrow: "自行架設",
        heading: "在你所在之處運行",
        intro:
          "Hollo 適用多種自行架設的部署方式。",
        features: [
          {
            title: "彈性的儲存",
            body: "將媒體存放在本機檔案系統，或任何相容 S3 的物件儲存中。",
          },
          {
            title: "媒體代理",
            body: "可選擇透過你自己的來源代理或快取遠端大頭貼、圖片與表情，以保護隱私。",
          },
          {
            title: "工作程序分離",
            body: "拆分網頁程序與工作程序，獨立擴充背景工作。",
          },
          {
            title: "資料匯入",
            body: "從 Mastodon 或 Iceshrimp 的匯出檔匯入你的追蹤、清單、靜音、封鎖與書籤。",
          },
        ],
      },
    },
    fedify: {
      eyebrow: "基石",
      heading: "由 Fedify 提供支援",
      body: "Hollo 以 Fedify 打造，這是一個面向 TypeScript 的 ActivityPub 伺服端框架。HTTP 簽章、物件完整性證明、WebFinger、NodeInfo 這些聯邦中的難題都交給 Fedify，Hollo 便能專注於做好一款微博。",
      linkText: "了解 Fedify",
    },
    getStarted: {
      eyebrow: "開始使用",
      heading: "依你的方式安裝 Hollo",
      intro: "Hollo 需要 PostgreSQL 與一處存放媒體的空間。挑選適合你的方式。",
      steps: [
        { title: "部署到 Railway", body: "搭配代管的 PostgreSQL，一鍵部署。" },
        { title: "用 Docker 執行", body: "用 Docker Compose 啟動已發布的映像檔。" },
        { title: "手動安裝", body: "用 Node.js 與 pnpm 從原始碼執行。" },
      ],
    },
    closing: {
      heading: "經營屬於你自己的聯邦宇宙一隅",
      body: "Hollo 免費、開源，而且可以自行架設。",
      primaryText: "安裝 Hollo",
      secondaryText: "在 GitHub 查看原始碼",
    },
  },
};

// ---------------------------------------------------------------------------
// Merge structure + copy
// ---------------------------------------------------------------------------

/** Prefix an internal path with the locale base (English is served at root). */
function localizePath(locale: Locale, path: string): string {
  return locale === "en" ? path : `/${locale}${path}`;
}

export function getLanding(locale: Locale): Landing {
  const c = COPY[locale];

  const sections: FeatureSection[] = SECTION_ORDER.map((id) => {
    const t = c.sections[id];
    const icons = SECTION_ICONS[id];
    const linkPath = SECTION_LINKS[id];
    return {
      id,
      eyebrow: t.eyebrow,
      heading: t.heading,
      intro: t.intro,
      features: t.features.map((f, i) => {
        const featureLink = SECTION_FEATURE_LINKS[id]?.[i];
        return {
          icon: icons[i] ?? "lucide:dot",
          title: f.title,
          body: f.body,
          link: featureLink
            ? { text: f.title, href: localizePath(locale, featureLink), external: false }
            : undefined,
        };
      }),
      link:
        linkPath != null && t.linkText != null
          ? { text: t.linkText, href: localizePath(locale, linkPath), external: false }
          : undefined,
    };
  });

  return {
    hero: {
      tagline: c.hero.tagline,
      subhead: c.hero.subhead,
      meta: c.hero.meta,
      primary: {
        text: c.hero.primaryText,
        href: localizePath(locale, HREF_INSTALL),
        external: false,
      },
      secondary: {
        text: c.hero.secondaryText,
        href: localizePath(locale, HREF_INTRO),
        external: false,
      },
      tertiary: { text: c.hero.tertiaryText, href: EXTERNAL_INSTANCE, external: true },
    },
    about: c.about,
    federation: {
      eyebrow: c.federation.eyebrow,
      heading: c.federation.heading,
      body: c.federation.body,
      platformsLabel: c.federation.platformsLabel,
      platforms: PLATFORMS,
    },
    sections,
    fedify: {
      eyebrow: c.fedify.eyebrow,
      heading: c.fedify.heading,
      body: c.fedify.body,
      link: { text: c.fedify.linkText, href: EXTERNAL_FEDIFY, external: true },
    },
    getStarted: {
      eyebrow: c.getStarted.eyebrow,
      heading: c.getStarted.heading,
      intro: c.getStarted.intro,
      steps: c.getStarted.steps.map((s, i) => ({
        icon: STEP_ICONS[i] ?? "lucide:dot",
        title: s.title,
        body: s.body,
        href: localizePath(locale, STEP_HREFS[i] ?? HREF_INSTALL),
      })),
    },
    closing: {
      heading: c.closing.heading,
      body: c.closing.body,
      primary: {
        text: c.closing.primaryText,
        href: localizePath(locale, HREF_INSTALL),
        external: false,
      },
      secondary: {
        text: c.closing.secondaryText,
        href: EXTERNAL_GITHUB,
        external: true,
      },
    },
  };
}
