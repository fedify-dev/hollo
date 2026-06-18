<picture>
  <source srcset="logo-white.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-black.svg" width="50" height="50">
</picture>

Hollo
=====

[![Matrix][Matrix badge]][Matrix]
[![公式Hollo][Official Hollo badge]][Official Hollo]

_他の言語でも読めます: [English](./README.en.md)（英語）、
[한국어](./README.ko.md)（韓国語）、
[简体中文](./README.zh-CN.md)（簡体字中国語）、
[繁體中文](./README.zh-TW.md)（繁体字中国語）。_

Holloは[Fedify]を利用した、簡単な一人様向けマイクロブログです。
個人用Mastodonのインスタンスと考えてもいいですが、本当に必要な機能だけで
構成されています。

Holloの特徴は、[フェディバース]の一部であることです。  フェディバースとは、
[ActivityPub]プロトコルを介して相互に接続されたサーバーのネットワークを
意味します。  つまり、Holloを使用すると、MastodonやMisskeyなど他の
フェディバースのプラットフォームのユーザーと接続することができます。

Holloは、独自のウェブインタフェースを持たない「ヘッドレス」（headless）
ソフトウェアです。  代わりにMastodon互換APIを実装しているため、ほとんどの
[既存のMastodon互換クライアントアプリ]
でHolloを使用することができます。

[Matrix badge]: https://img.shields.io/matrix/fedify%3Amatrix.org?logo=matrix
[Matrix]: https://matrix.to/#/%23hollo-users:matrix.org
[Official Hollo badge]: https://fedi-badge.minhee.org/@hollo@hollo.social/followers.svg
[Official Hollo]: https://hollo.social/@hollo
[Fedify]: https://fedify.dev/
[フェディバース]: https://ja.wikipedia.org/wiki/Fediverse
[ActivityPub]: https://www.w3.org/TR/activitypub/
[既存のMastodon互換クライアントアプリ]: https://docs.hollo.social/ja/clients/


ドキュメント
------------

 -  [Holloとは？]
 -  インストール
     -  [Railwayにデプロイ]
     -  [Dockerを使ってデプロイ]
     -  [手動インストール]
     -  [環境変数]
     -  [初期設定]
     -  [ワーカーノードの分離]
     -  [ドメイン分離 WebFinger]
 -  [テスト済みクライアント]
 -  [検索]

[Holloとは？]: https://docs.hollo.social/ja/intro/
[Railwayにデプロイ]: https://docs.hollo.social/ja/install/railway/
[Dockerを使ってデプロイ]: https://docs.hollo.social/ja/install/docker/
[手動インストール]: https://docs.hollo.social/ja/install/manual/
[環境変数]: https://docs.hollo.social/ja/install/env/
[初期設定]: https://docs.hollo.social/ja/install/setup/
[ワーカーノードの分離]: https://docs.hollo.social/ja/install/workers/
[ドメイン分離 WebFinger]: https://docs.hollo.social/ja/install/split-domain/
[テスト済みクライアント]: https://docs.hollo.social/ja/clients/
[検索]: https://docs.hollo.social/ja/search/
