<picture>
  <source srcset="logo-white.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-black.svg" width="50" height="50">
</picture>

Hollo
=====

[![Matrix][Matrix badge]][Matrix]
[![Hollo 官方账号][Official Hollo badge]][Official Hollo]

_也可阅读其他语言版本：[English](./README.en.md)（英语）、
[日本語](./README.ja.md)（日语）、
[한국어](./README.ko.md)（韩语）、
[繁體中文](./README.zh-TW.md)（繁体中文）。_

Hollo 是由 [Fedify] 驱动的简单单用户微博工具，让你可以在网络上拥有自己的
小天地。  你可以将它视为你的个人 Mastodon 实例，但仅保留了核心功能。

Hollo 的独特之处在于它是 [联邦宇宙] 的一部分。  联邦宇宙是一个运行在开放
协议上的互联服务器网络，主要使用 [ActivityPub]。  这意味着你可以与
Mastodon、Misskey 等其他平台上的用户连接和互动。

Hollo 是所谓的「无头」软件，意思是它没有自己的网页界面。  相反，它实现了
Mastodon 兼容 API，因此你可以使用大多数
[Mastodon 兼容应用程序]与
Hollo 互动。

[Matrix badge]: https://img.shields.io/matrix/fedify%3Amatrix.org?logo=matrix
[Matrix]: https://matrix.to/#/%23hollo-users:matrix.org
[Official Hollo badge]: https://fedi-badge.minhee.org/@hollo@hollo.social/followers.svg
[Official Hollo]: https://hollo.social/@hollo
[Fedify]: https://fedify.dev/
[联邦宇宙]: https://www.theverge.com/24063290/fediverse-explained-activitypub-social-media-open-protocol
[ActivityPub]: https://www.w3.org/TR/activitypub/
[Mastodon 兼容应用程序]: https://docs.hollo.social/zh-cn/clients/


文档
----

 -  [什么是 Hollo？]
 -  安装
     -  [部署到 Railway]
     -  [使用 Docker 部署]
     -  [手动安装]
     -  [环境变量]
     -  [配置指南]
     -  [分离工作节点]
     -  [分域 WebFinger]
 -  [测试过的客户端]
 -  [搜索]

[什么是 Hollo？]: https://docs.hollo.social/zh-cn/intro/
[部署到 Railway]: https://docs.hollo.social/zh-cn/install/railway/
[使用 Docker 部署]: https://docs.hollo.social/zh-cn/install/docker/
[手动安装]: https://docs.hollo.social/zh-cn/install/manual/
[环境变量]: https://docs.hollo.social/zh-cn/install/env/
[配置指南]: https://docs.hollo.social/zh-cn/install/setup/
[分离工作节点]: https://docs.hollo.social/zh-cn/install/workers/
[分域 WebFinger]: https://docs.hollo.social/zh-cn/install/split-domain/
[测试过的客户端]: https://docs.hollo.social/zh-cn/clients/
[搜索]: https://docs.hollo.social/zh-cn/search/
