<picture>
  <source srcset="logo-white.svg" media="(prefers-color-scheme: dark)">
  <img src="logo-black.svg" width="50" height="50">
</picture>

Hollo
=====

[![Matrix][Matrix badge]][Matrix]
[![공식 Hollo][Official Hollo badge]][Official Hollo]

_다른 언어로도 볼 수 있습니다: [English](./README.en.md) (영어),
[日本語](./README.ja.md) (일본어),
[简体中文](./README.zh-CN.md) (중국어 간체),
[繁體中文](./README.zh-TW.md) (중국어 번체)._

Hollo는 [Fedify] 기반의 간편한 1인 사용자용 마이크로블로그입니다.
개인용 Mastodon 인스턴스라고 생각해도 되지만, 정말 필요한 기능들로만 구성되어
있습니다.

Hollo의 특징은 [연합우주]의 일부라는 것입니다.  연합우주란 [ActivityPub]
프로토콜을 통해 서로 연결된 서버들의 네트워크를 뜻합니다.  따라서 Hollo를
사용하면 Mastodon, Misskey 같은 다른 연합우주 플랫폼의 사용자들과 연결될 수
있습니다.

Hollo는 자체적인 웹 인터페이스가 없는 「헤들리스」 소프트웨어입니다.  대신
Mastodon 호환 API를 구현하므로 대부분의
[기존 Mastodon 클라이언트 앱]으로
Hollo를 사용할 수 있습니다.

[Matrix badge]: https://img.shields.io/matrix/fedify%3Amatrix.org?logo=matrix
[Matrix]: https://matrix.to/#/%23hollo-users:matrix.org
[Official Hollo badge]: https://fedi-badge.minhee.org/@hollo@hollo.social/followers.svg
[Official Hollo]: https://hollo.social/@hollo
[Fedify]: https://fedify.dev/
[연합우주]: https://ko.wikipedia.org/wiki/%EC%97%B0%ED%95%A9_%EC%9A%B0%EC%A3%BC
[ActivityPub]: https://www.w3.org/TR/activitypub/
[기존 Mastodon 클라이언트 앱]: https://docs.hollo.social/ko/clients/


문서
----

 -  [Hollo란?]
 -  설치
     -  [Railway로 배포하기]
     -  [Docker로 배포하기]
     -  [수동 설치]
     -  [환경 변수]
     -  [설정하기]
     -  [워커 노드 분리]
     -  [도메인 분리 WebFinger]
 -  [테스트된 클라이언트]
 -  [검색]

[Hollo란?]: https://docs.hollo.social/ko/intro/
[Railway로 배포하기]: https://docs.hollo.social/ko/install/railway/
[Docker로 배포하기]: https://docs.hollo.social/ko/install/docker/
[수동 설치]: https://docs.hollo.social/ko/install/manual/
[환경 변수]: https://docs.hollo.social/ko/install/env/
[설정하기]: https://docs.hollo.social/ko/install/setup/
[워커 노드 분리]: https://docs.hollo.social/ko/install/workers/
[도메인 분리 WebFinger]: https://docs.hollo.social/ko/install/split-domain/
[테스트된 클라이언트]: https://docs.hollo.social/ko/clients/
[검색]: https://docs.hollo.social/ko/search/
