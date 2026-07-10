Federation
==========

Hollo is a single-user microblogging server that federates through [Fedify].
Fedify provides the protocol, signature, JSON-LD, and vocabulary layers, while
Hollo defines the actors, objects, collections, and activity handlers described
below.

[Fedify]: https://fedify.dev/


Supported federation protocols and standards
--------------------------------------------

 -  [ActivityPub] (server-to-server)
 -  [WebFinger] (RFC 7033)
 -  [HTTP Message Signatures] (RFC 9421)
 -  [HTTP Signatures] (draft-cavage-http-signatures-12)
 -  [Linked Data Signatures]
 -  [NodeInfo] 2.1

[ActivityPub]: https://www.w3.org/TR/activitypub/
[WebFinger]: https://datatracker.ietf.org/doc/html/rfc7033
[HTTP Message Signatures]: https://www.rfc-editor.org/rfc/rfc9421
[HTTP Signatures]: https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures-12
[Linked Data Signatures]: https://web.archive.org/web/20170923124140/https://w3c-dvcg.github.io/ld-signatures/
[NodeInfo]: https://nodeinfo.diaspora.software/


Supported FEPs
--------------

 -  [FEP-67ff][]: FEDERATION.md
 -  [FEP-0151][]: NodeInfo in Fediverse Software (2025 edition)
 -  [FEP-f1d5][]: NodeInfo in Fediverse Software
 -  [FEP-8b32][]: Object Integrity Proofs
 -  [FEP-521a][]: Representing actor's public keys
 -  [FEP-fe34][]: Origin-based security model
 -  [FEP-c0e0][]: Emoji reactions
 -  [FEP-e232][]: Object Links
 -  [FEP-044f][]: Consent-respecting quote posts

[FEP-67ff]: https://w3id.org/fep/67ff
[FEP-0151]: https://w3id.org/fep/0151
[FEP-f1d5]: https://w3id.org/fep/f1d5
[FEP-8b32]: https://w3id.org/fep/8b32
[FEP-521a]: https://w3id.org/fep/521a
[FEP-fe34]: https://w3id.org/fep/fe34
[FEP-c0e0]: https://w3id.org/fep/c0e0
[FEP-e232]: https://w3id.org/fep/e232
[FEP-044f]: https://w3id.org/fep/044f


ActivityPub
-----------

Hollo implements the server-to-server part of ActivityPub.  Client applications
use Hollo's Mastodon-compatible API rather than the ActivityPub client-to-server
API.

### Actors and discovery

Hollo publishes local accounts as `Person` or `Service` actors and accepts
remote `Application`, `Group`, `Organization`, `Person`, and `Service` actors.
Actors expose inbox, shared inbox, outbox, followers, following, liked,
featured-post, and featured-tag collections.  Account discovery uses WebFinger,
including deployments where the WebFinger domain differs from the ActivityPub
server origin.

Local actors publish an RSA key for HTTP Signatures and Linked Data Signatures,
plus an Ed25519 `Multikey` in `assertionMethod`.  Fedify attaches FEP-8b32
integrity proofs to outgoing activities and verifies supported proofs and
signatures on incoming activities.

### Objects and interactions

Local posts are `Note` objects or `Question` objects for polls.  Hollo also
accepts remote `Article`, `ChatMessage`, `Note`, and `Question` objects.  Posts
can contain mentions, hashtags, custom emoji, images, video, content warnings,
language metadata, replies, and audience information for public, unlisted,
followers-only, and direct visibility.

Hollo sends and processes follows, favorites, boosts, blocks, account moves,
post creation and updates, deletion, pinning, poll votes, and undo activities.
It sends `Flag` activities for reports.  Hollo also supports `EmojiReact`
activities and paginated `emojiReactions` collections as defined by FEP-c0e0.

Quote posts use FEP-e232 object links and the FEP-044f quote,
interaction-policy, request, acceptance, rejection, authorization, and
revocation flows.  Legacy `quoteUrl` is also understood for compatibility with
older software.

### Delivery and fetching

Activities are delivered asynchronously, with shared-inbox delivery used when
available.  Hollo accepts both RFC 9421 HTTP Message Signatures and the older
draft-cavage HTTP Signatures format.  For interoperability with existing
servers, outgoing delivery currently tries the draft-cavage format first.

Followers-only and direct objects require a signed fetch from an actor in the
object's audience.  Public and unlisted posts are available through the local
actor's outbox.  Hollo can crawl remote `replies` collections to discover
conversation replies that were not delivered directly to it.


Additional documentation
------------------------

 -  [Hollo documentation]
 -  [Fedify federation support]
 -  [Split-domain WebFinger setup]

[Hollo documentation]: https://docs.hollo.social/
[Fedify federation support]: https://github.com/fedify-dev/fedify/blob/main/FEDERATION.md
[Split-domain WebFinger setup]: https://docs.hollo.social/install/split-domain/
