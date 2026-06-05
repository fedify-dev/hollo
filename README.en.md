<picture>
  <source srcset="logo-white.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-black.svg" width="50" height="50">
</picture>

Hollo
=====

[![Matrix][Matrix badge]][Matrix]
[![Official Hollo][Official Hollo badge]][Official Hollo]

_Other languages are available: [日本語](./README.ja.md) (Japanese),
[한국어](./README.ko.md) (Korean),
[简体中文](./README.zh-CN.md) (Simplified Chinese),
[繁體中文](./README.zh-TW.md) (Traditional Chinese)._

Hollo is a simple, single-user microblogging tool powered by [Fedify].
It lets you run your own little corner of the internet: think of it as
your personal Mastodon instance, but stripped down to the essentials.

Hollo is part of the [fediverse], a network of interconnected servers running
on open protocols, primarily [ActivityPub].  This means you can connect and
interact with folks on other platforms like Mastodon, Misskey, and other
fediverse servers.

Hollo is “headless,” which means it does not have its own web interface.
Instead, it implements Mastodon-compatible APIs so that you can use it with
most [existing Mastodon clients].

[Matrix badge]: https://img.shields.io/matrix/fedify%3Amatrix.org?logo=matrix
[Matrix]: https://matrix.to/#/%23hollo-users:matrix.org
[Official Hollo badge]: https://fedi-badge.minhee.org/@hollo@hollo.social/followers.svg
[Official Hollo]: https://hollo.social/@hollo
[Fedify]: https://fedify.dev/
[fediverse]: https://www.theverge.com/24063290/fediverse-explained-activitypub-social-media-open-protocol
[ActivityPub]: https://www.w3.org/TR/activitypub/
[existing Mastodon clients]: https://docs.hollo.social/clients/


Docs
----

 -  [What is Hollo?]
 -  Installation
     -  [Deploy to Railway]
     -  [Deploy using Docker]
     -  [Manual installation]
     -  [Environment variables]
     -  [Setting up]
     -  [Separating worker nodes]
     -  [Split-domain WebFinger]
 -  [Tested clients]
 -  [Search]

[What is Hollo?]: https://docs.hollo.social/intro/
[Deploy to Railway]: https://docs.hollo.social/install/railway/
[Deploy using Docker]: https://docs.hollo.social/install/docker/
[Manual installation]: https://docs.hollo.social/install/manual/
[Environment variables]: https://docs.hollo.social/install/env/
[Setting up]: https://docs.hollo.social/install/setup/
[Separating worker nodes]: https://docs.hollo.social/install/workers/
[Split-domain WebFinger]: https://docs.hollo.social/install/split-domain/
[Tested clients]: https://docs.hollo.social/clients/
[Search]: https://docs.hollo.social/search/
