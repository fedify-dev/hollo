---
priority: -40
---
 -  The admin dashboard's *Auth* page now lists the applications holding an
    OAuth access token for the instance, grouped by application, and lets you
    revoke a single token or every token belonging to an application.  Revoked
    tokens stop working immediately.  Revoking an application's tokens also
    revokes its pending authorization codes, so a code issued before the
    revocation can no longer be exchanged for a token.  Previously tokens never
    expired and only the client application itself could revoke them.

 -  The `scope` parameter of `POST /oauth/token` and `POST /oauth/authorize`
    now deduplicates the scopes it is given.  [RFC 6749] treats `scope` as a
    set, so this does not change which scopes a token carries; it only stops a
    request from recording the same scope arbitrarily many times.

 -  The `website` field of `POST /api/v1/apps` is now limited to 2,048
    characters.  The endpoint requires no authentication, and the value was
    previously stored unbounded and shown on the admin dashboard.

[RFC 6749]: https://datatracker.ietf.org/doc/html/rfc6749#section-3.3
