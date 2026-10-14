---
priority: -130
links:
  '#602': https://github.com/fedify-dev/hollo/issues/602
  '#635': https://github.com/fedify-dev/hollo/issues/635
  '#640': https://github.com/fedify-dev/hollo/issues/640
  '#641': https://github.com/fedify-dev/hollo/pull/641
  '#660': https://github.com/fedify-dev/hollo/pull/660
---
 -  Quotes awaiting [FEP-044f] approval now expose `quoteUrl` for compatibility
    with older software when the original public or unlisted post explicitly
    allows automatic approval for everyone.  The `quote` field and generated
    fallback still wait for approval.  Rejection or revocation removes the
    reference through an `Update`; failed rejection updates can be retried
    without changing the quote state or counts.  [[#602]]

 -  [FEP-044f] quote authorization now uses Fedify's
    *@fedify/interaction-controls* package to build and verify quote
    requests and authorizations and to evaluate local quote policies.
    Verification is stricter in a few cases:  [[#635], [#641]]

     -  Incoming `QuoteRequest` activities must have an `id` and an `actor`,
        and their quote post's `quote` and `quoteUrl` must point to the same
        post.  Invalid requests are ignored before the quote post is stored.
     -  An embedded quote post from another origin is fetched from its own
        server instead of being trusted.
     -  A `QuoteAuthorization` from an `Accept` or from a remote quote post is
        always fetched from its IRI.  Embedded authorization contents are not
        trusted.  The authorization must be hosted on the same origin as the
        quoted post's author.  If the authorization can't be fetched because
        of a temporary failure, the `Accept` is retried later.
     -  Outgoing `Accept` and `Reject` responses to quote requests now have
        explicit IDs and address the requester in `to`.

 -  Remote quotes without [FEP-044f] approval are now accepted when the local
    target is public or unlisted, allows automatic quotes by everyone
    (including the default policy), and neither account blocks the other.
    Accepted quotes have a local authorization and appear in quote counts
    and notifications.  Cached unauthorized quotes are reevaluated on later
    updates; there is no backfill.  Revoked quotes retain their state on
    updates for the same target, including remote targets.  [[#640], [#660]]

[FEP-044f]: https://w3id.org/fep/044f
