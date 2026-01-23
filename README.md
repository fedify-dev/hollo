<picture>
  <source srcset="logo-white.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-black.svg" width="50" height="50">
</picture>


Hollo
=====

[![Matrix][Matrix badge]][Matrix]
[![Discord][Discord badge]][Discord]
[![Official Hollo][Official Hollo badge]][Official Hollo]

Hollo is a federated single-user microblogging software powered by [Fedify].
Although it is for single-user, it is designed to be federated through
[ActivityPub], which means that you can follow and be followed by other users
from other instances, even from other software that supports ActivityPub like
Mastodon, Misskey, and so on.

Hollo does not have its own web interface.  Instead, it implements
Mastodon-compatible APIs so that you can integrate it with the most of
the [existing Mastodon clients](https://docs.hollo.social/clients/).

[Matrix badge]: https://img.shields.io/matrix/hollo-users%3Amatrix.org?logo=matrix
[Matrix]: https://matrix.to/#/%23hollo-users:matrix.org
[Discord badge]: https://img.shields.io/discord/1295652627505217647?logo=discord&cacheSeconds=60
[Discord]: https://discord.gg/hGXXxUq2jK
[Official Hollo]: https://hollo.social/@hollo
[Official Hollo badge]: https://fedi-badge.deno.dev/@hollo@hollo.social/followers.svg
[Fedify]: https://fedify.dev/
[ActivityPub]: https://www.w3.org/TR/activitypub/


Docs
----

 -  [What is Hollo?](https://docs.hollo.social/intro/)
 -  Installation
     -  [Deploy to Railway](https://docs.hollo.social/install/railway/)
     -  [Deploy using Docker](https://docs.hollo.social/install/docker/)
     -  [Manual installation](https://docs.hollo.social/install/manual/)
     -  [Environment variables](https://docs.hollo.social/install/env/)
     -  [Setting up](https://docs.hollo.social/install/setup/)
 -  [Tested clients](https://docs.hollo.social/clients/)
 -  [Search](https://docs.hollo.social/search/)
