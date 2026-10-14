---
priority: -110
---
 -  Added [FEP-c0e0] `emojiReactions` collections to local ActivityPub
    `Note`, `Question`, and `Article` objects, exposing stored emoji
    reactions as paginated `EmojiReact` activities at
    `/@{username}/{id}/reactions`.

 -  Added support for importing [FEP-c0e0] `emojiReactions` collections
    from remote `Note`, `Question`, and `Article` objects when they are
    persisted.

[FEP-c0e0]: https://w3id.org/fep/c0e0
