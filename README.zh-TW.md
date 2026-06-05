<picture>
  <source srcset="logo-white.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-black.svg" width="50" height="50">
</picture>

Hollo
=====

[![Matrix][Matrix badge]][Matrix]
[![Hollo 官方帳號][Official Hollo badge]][Official Hollo]

_也可閱讀其他語言版本：[English](./README.en.md)（英語）、
[日本語](./README.ja.md)（日語）、
[한국어](./README.ko.md)（韓語）、
[简体中文](./README.zh-CN.md)（簡體中文）。_

Hollo 是由 [Fedify] 驅動的簡單單用戶微網誌工具，讓你可以在網路上擁有自己的
小天地。你可以將它視為你的個人 Mastodon 實例，但僅保留了核心功能。

Hollo 的獨特之處在於它是 [聯邦宇宙] 的一部分。聯邦宇宙是一個運行在開放
協定上的互聯伺服器網路，主要使用 [ActivityPub]。這意味著你可以與
Mastodon、Misskey 等其他平台上的用戶連接和互動。

Hollo 是所謂的「無頭」軟體，意思是它沒有自己的網頁介面。相反，它實作了
Mastodon 相容 API，因此你可以使用大多數
[Mastodon 相容應用程式]與
Hollo 互動。

[Matrix badge]: https://img.shields.io/matrix/fedify%3Amatrix.org?logo=matrix
[Matrix]: https://matrix.to/#/%23hollo-users:matrix.org
[Official Hollo badge]: https://fedi-badge.minhee.org/@hollo@hollo.social/followers.svg
[Official Hollo]: https://hollo.social/@hollo
[Fedify]: https://fedify.dev/
[聯邦宇宙]: https://www.theverge.com/24063290/fediverse-explained-activitypub-social-media-open-protocol
[ActivityPub]: https://www.w3.org/TR/activitypub/
[Mastodon 相容應用程式]: https://docs.hollo.social/zh-tw/clients/


文件
----

 -  [什麼是 Hollo？]
 -  安裝
     -  [部署到 Railway]
     -  [使用 Docker 部署]
     -  [手動安裝]
     -  [環境變數]
     -  [初始設定]
     -  [分離工作節點]
     -  [分域 WebFinger]
 -  [已測試的客戶端]
 -  [搜尋]

[什麼是 Hollo？]: https://docs.hollo.social/zh-tw/intro/
[部署到 Railway]: https://docs.hollo.social/zh-tw/install/railway/
[使用 Docker 部署]: https://docs.hollo.social/zh-tw/install/docker/
[手動安裝]: https://docs.hollo.social/zh-tw/install/manual/
[環境變數]: https://docs.hollo.social/zh-tw/install/env/
[初始設定]: https://docs.hollo.social/zh-tw/install/setup/
[分離工作節點]: https://docs.hollo.social/zh-tw/install/workers/
[分域 WebFinger]: https://docs.hollo.social/zh-tw/install/split-domain/
[已測試的客戶端]: https://docs.hollo.social/zh-tw/clients/
[搜尋]: https://docs.hollo.social/zh-tw/search/
