Hollo changelog
===============

Version 0.7.0
-------------

To be released.

 -  Significantly improved `/api/v1/notifications` endpoint performance by
    implementing a materialized notifications system. The endpoint now uses
    dedicated `notifications` and `notification_groups` tables instead of
    generating notifications on-demand via complex SQL queries, resulting in
    approximately 24% improvement (2.5s → 1.9s). Key changes include:

     -  Added `notifications` table to store notification events as they occur
        during federation activities (follows, likes, mentions, shares, etc).
     -  Added `notification_groups` table for Mastodon-compatible notification
        grouping and aggregation metadata.
     -  Implemented automatic notification creation in federation inbox handlers
        for all notification types.
     -  Backfilled recent notifications (100 per type) during migration to
        prevent empty notification lists after upgrade.
     -  Poll expiry notifications are queried dynamically on-demand since they
        cannot be pre-generated without background job scheduling.

 -  Enabled gzip/deflate compression for all API responses, reducing response
    sizes by 70-92% and improving overall API performance. For example,
    `/api/v1/notifications` responses are now compressed from 767KB to 58KB,
    `/api/v1/timelines/home` from 91KB to 14KB, resulting in faster load times
    and reduced bandwidth usage.

 -  Implemented Mastodon v2 grouped notifications API (`/api/v2/notifications`),
    which provides server-side notification grouping to reduce client complexity
    and improve performance. The API groups notifications of types `favourite`,
    `follow`, `reblog`, `admin.sign_up`, and `emoji_reaction` together when they
    target the same post or account. New endpoints include:

     -  `GET /api/v2/notifications` - Get paginated grouped notifications with
        deduplicated accounts and statuses
     -  `GET /api/v2/notifications/:group_key` - Get a specific notification group
     -  `GET /api/v2/notifications/:group_key/accounts` - Get all accounts in a
        notification group
     -  `POST /api/v2/notifications/:group_key/dismiss` - Dismiss a notification
        group
     -  `GET /api/v2/notifications/unread_count` - Get unread notification count

 -  Fixed `POST /api/v1/statuses` and `PUT /api/v1/statuses/:id` endpoints
    rejecting FormData requests.  These endpoints now properly accept both
    JSON and FormData content types, improving compatibility with Mastodon
    clients that send `multipart/form-data` requests.
    [[#170], [#171] by Emelia Smith]

 -  Fixed a bug where multiple JSON objects were written on a single line
    in log files when `LOG_FILE` environment variable was set.  Upgraded
    LogTape to 1.2 and now uses `jsonLinesFormatter` to ensure proper
    JSON Lines format with one JSON object per line.  [[#174]]

 -  Fixed `POST /api/v1/statuses` endpoint rejecting requests with `null`
    values in optional fields. The endpoint now properly accepts `null`
    values for fields like `media_ids`, `poll`, `spoiler_text`,
    `in_reply_to_id`, and other optional parameters, improving
    compatibility with Mastodon clients.  [[#177], [#179] by Lee ByeongJun]

 -  Implemented asynchronous import job processing with a background worker
    to improve the reliability and performance of account data imports
    (following accounts, lists, muted/blocked accounts, bookmarks).
    Large imports no longer block the HTTP request, and users can see
    real-time progress of their imports.  [[#94], [#295] by Juyoung Jung]

 -  Upgraded Fedify to 1.9.1.

[#94]: https://github.com/fedify-dev/hollo/issues/94
[#295]: https://github.com/fedify-dev/hollo/pull/295
[#170]: https://github.com/fedify-dev/hollo/issues/170
[#171]: https://github.com/fedify-dev/hollo/pull/171
[#174]: https://github.com/fedify-dev/hollo/pull/174
[#177]: https://github.com/fedify-dev/hollo/issues/177
[#179]: https://github.com/fedify-dev/hollo/pull/179


Version 0.6.18
--------------

Released on November 15, 2025.

 -  Reverted the `/api/v1/notifications` endpoint query optimization from 0.6.17
    due to a regression that caused server errors when serializing reactions
    without account information. The optimization attempted to reduce query
    complexity by separating post data loading, but inadvertently broke reaction
    serialization for nested posts (shares and quotes). Database indexes added
    in 0.6.17 are retained.


Version 0.6.17
--------------

Released on November 15, 2025.

 -  Significantly improved `/api/v1/notifications` endpoint performance by
    optimizing database queries and restructuring data loading strategy.
    The endpoint now responds in under 1.6 seconds, down from over 2.5 seconds
    previously (approximately 40% improvement). Key optimizations include:

     -  Pre-fetching muted and blocked account IDs to eliminate correlated
        subqueries in notification type queries.
     -  Separating post data loading into multiple targeted queries instead of
        using deeply nested lateral joins, reducing query complexity and
        execution time.
     -  Adding strategic database indexes on `follows`, `mutes`, `likes`, and
        `reactions` tables to improve query performance.


Version 0.6.16
--------------

Released on November 12, 2025.

 -  Fixed search functionality not returning any results when searching for
    post content.

 -  Fixed search results including shared posts (reposts/reblogs). Search now
    shows only original posts and replies, excluding shares.


Version 0.6.15
--------------

Released on November 7, 2025.

 -  Significantly improved `/nodeinfo/2.1` endpoint performance by optimizing
    database queries and adding appropriate indexes. The endpoint now responds
    in under 1 second even with millions of federated posts, down from 5–15
    seconds previously. This prevents load balancer health check failures and
    external service timeouts.  [[#282]]

[#282]: https://github.com/fedify-dev/hollo/issues/282


Version 0.6.14
--------------

Released on October 7, 2025.

 -  Fixed a critical security vulnerability where direct messages (DMs) were
    visible to all authenticated users regardless of whether they were
    participants in the conversation. The visibility filter now correctly
    restricts direct messages to only the sender and mentioned recipients,
    preventing unauthorized access to private conversations.
    [[#247], [#255] by Hyeonseo Kim]

[#247]: https://github.com/fedify-dev/hollo/issues/247
[#255]: https://github.com/fedify-dev/hollo/pull/255


Version 0.6.13
--------------

Released on October 7, 2025.

 -  Fixed a bug where replies from followers who are not followed back were not
    visible in conversation threads. The visibility filter now correctly
    includes posts that mention the authenticated user, ensuring that all
    replies directed to the user are displayed regardless of follow-back status.


Version 0.6.12
--------------

Released on October 4, 2025.

 -  Fixed a critical security vulnerability where direct messages were leaked
    on public post pages. The replies list below posts now correctly filters
    to show only public or unlisted replies, preventing private conversations
    from being exposed.  [[#246], [#248] by Hyeonseo Kim]

[#246]: https://github.com/fedify-dev/hollo/issues/246
[#248]: https://github.com/fedify-dev/hollo/pull/248


Version 0.6.11
--------------

Released on September 17, 2025.

 -  Fixed a bug where `Like` activities from Bluesky via BridgyFed were not
    being received due to invalid AT Protocol URIs.  This was resolved by
    upgrading Fedify to 1.5.9, which includes improved AT Protocol URI
    handling to properly parse URIs with DID authorities.  [[#217]]

[#217]: https://github.com/fedify-dev/hollo/issues/217


Version 0.6.10
--------------

Released on August 26, 2025.

 -  Upgraded Fedifyh to 1.5.7 which fixes a bug where HTTP Signature
    verification failed for requests having `created` or `expires` fields
    in their `Signature` header, causing `500 Internal Server Error` responses
    in inbox handlers.


Version 0.6.9
-------------

Released on August 25, 2025.

 -  Fixed a bug where ActivityPub Discovery failed to recognize XHTML
    self-closing `<link>` tags. The HTML/XHTML parser now correctly handles
    whitespace before the self-closing slash (`/>`), improving compatibility
    with XHTML documents that follow the self-closing tag format.

 -  Upgraded Fedify to 1.5.6.


Version 0.6.8
-------------

Released on August 21, 2025.

 -  Fixed a critical bug introduced in 0.6.7 where the search query would return
    too many results, causing out-of-memory errors and query timeouts.  The issue
    was caused by incorrect logical operator precedence when filtering
    future-dated posts.  [[#207], [#208] by aliceif]

[#207]: https://github.com/fedify-dev/hollo/issues/207
[#208]: https://github.com/fedify-dev/hollo/pull/208


Version 0.6.7
-------------

Released on August 19, 2025.

 -  Fixed timeline pollution caused by future-dated posts from malicious or
    misconfigured remote instances.  Posts with timestamps more than 5 minutes
    in the future are now filtered from all timeline endpoints while preserving
    them in the database for future display.  [[#199], [#201] by Hyeonseo Kim]

[#199]: https://github.com/fedify-dev/hollo/issues/199
[#201]: https://github.com/fedify-dev/hollo/pull/201


Version 0.6.6
-------------

Released on August 8, 2025.

 -  Upgrade Fedify to 1.5.5, which includes a critical security
    fix [CVE-2025-54888] that addresses an authentication bypass
    vulnerability allowing actor impersonation.  [[CVE-2025-54888]]


Version 0.6.5
-------------

Released on July 17, 2025.

 -  Fixed an HTML injection vulnerability where form elements, scripts, and
    other potentially dangerous HTML tags in federated posts were not properly
    sanitized before rendering.  This could allow malicious actors to inject
    forms for phishing, execute JavaScript, or perform CSRF attacks.
    The fix implements strict HTML sanitization using an allowlist approach
    to ensure only safe HTML elements and attributes are rendered.
    [[CVE-2025-53941]]

[CVE-2025-53941]: https://github.com/fedify-dev/hollo/security/advisories/GHSA-w7gc-g3x7-hq8h


Version 0.6.4
-------------

Released on July 7, 2025.

 -  Fixed a regression bug where follower-only posts were returning `404 Not
    Found` errors when accessed through conversation threads. This was caused
    by improper OAuth scope checking that only accepted `read:statuses` scope
    but tokens contain `read` scope:  [[#169], [#172]]

     -  `GET /api/v1/statuses/:id`
     -  `GET /api/v1/statuses/:id/context`

[#169]: https://github.com/fedify-dev/hollo/issues/169
[#172]: https://github.com/fedify-dev/hollo/pull/172


Version 0.6.3
-------------

Released on June 23, 2025.

 -  Fixed a bug where remote posts mentioning the same user multiple times
    could not be retrieved due to database constraint violations.


Version 0.6.2
-------------

Released on June 8, 2025.

 -  Fixed an issue where Hollo 0.6.x installations upgraded from Hollo 0.5.x
    or earlier failed to sign in with Elk, a popular Mastodon client.
    This was caused by old application registrations incorrectly defaulting
    to non-confidential.  All existing applications are now properly set as
    confidential clients.  [[#167], [#168] by Emelia Smith]

[#167]: https://github.com/fedify-dev/hollo/issues/167
[#168]: https://github.com/fedify-dev/hollo/pull/168


Version 0.6.1
-------------

Released on June 5, 2025.

 -  Fixed `POST /oauth/token` endpoint rejecting requests with additional
    parameters not required by RFC 6749 but commonly sent by clients.
    The endpoint now gracefully ignores extra parameters like `scope` in
    `authorization_code` requests and `redirect_uri` in `client_credentials`
    requests instead of returning validation errors.
    [[#163], [#164] by Hong Minhee]

[#163]: https://github.com/fedify-dev/hollo/issues/163
[#164]: https://github.com/fedify-dev/hollo/pull/164


Version 0.6.0
-------------

Released on June 5, 2025.

 -  Revamped the environment variables for asset storage configuration.
    [[#115], [#121] by Emelia Smith]

     -  Added `FS_STORAGE_PATH` environment variable, which is required where
        `DRIVE_DISK` is set to `fs`.
     -  Added `STORAGE_URL_BASE` environment variable, which is required.
     -  Deprecated `FS_ASSET_PATH` in favor of `FS_STORAGE_PATH`.
     -  Deprecated `ASSET_URL_BASE` in favor of `STORAGE_URL_BASE`.

 -  Implemented OAuth 2.0 Authorization Code flow with support for access grants.
    This improves the security of the OAuth authorization process by separating
    the authorization code from the access token issuance.
    [[#130] by Emelia Smith]

 -  Hollo now requires the `SECRET_KEY` environment variable to be at least 44
    characters long.  This change ensures sufficient entropy for cryptographic
    operations.  [[#126] by Emelia Smith]

 -  Hollo now lets */.well-known/* and */oauth/* endpoints allow cross origin
    requests which is aligned with those of Mastodon.  [[#126] by Emelia Smith]

 -  Added the `BIND` environment variable to specify the host address to
    listen on.  [[#114], [#120] by Emelia Smith]

 -  The theme color of the profile page is now customizable.  The list of all
    available theme colors can be found in the [*Colors* section] of the Pico
    CSS docs.

 -  You can now sign out from the administration dashboard.
    [[#50], [#122] by Emelia Smith]

 -  On profile page, shared posts are now more visually separated from the
    original posts, and the time of sharing is now shown.  [[#111]]

 -  On profile page, alt texts for images are now expanded within `<details>`.
    [[#99], [#110] by Okuto Oyama]

 -  The `scope` parameter is now optional for `POST /oauth/token` endpoint.

 -  The current version string is displayed at the bottom of the dashboard page.
    [[#136], [#137] by RangHo Lee]

 -  Increased the maximum character limit for posts from 4,096 to 10,000
    characters.

 -  EXIF metadata of attached images are now stripped before storing them
    to prevent privacy leaks.  [[#152] by NTSK]

 -  Code blocks inside Markdown are now highlighted.  The syntax highlighting is
    powered By [Shiki].  See also the [complete list of supported languages].
    [[#149]]

 -  Implemented OAuth 2.0 Proof Key for Code Exchange (PKCE) support with the
    `S256` code challenge method.  This enhances security by preventing
    authorization code interception attacks in the OAuth authorization flow.
    [[#155] by Emelia Smith]

 -  Added support for the `profile` OAuth scope for enhanced user authentication.
    This allows applications to request limited profile information using the
    new `/oauth/userinfo` endpoint and enables the `profile` scope to be used
    with the `GET /api/v1/accounts/verify_credentials` endpoint.
    [[#45], [#156] by Emelia Smith]

 -  Made few Mastodon API endpoints publicly accessible without
    authentication so that they behave more similarly to Mastodon:

     -  `GET /api/v1/statuses/:id`
     -  `GET /api/v1/statuses/:id/context`

 -  Upgraded Fedify to 1.5.3 and *@fedify/postgres* to 0.3.0.

 -  The minimum required version of Node.js is now 24.0.0.

[*Colors* section]: https://picocss.com/docs/colors
[Shiki]: https://shiki.style/
[complete list of supported languages]: https://shiki.style/languages
[#45]: https://github.com/fedify-dev/hollo/issues/45
[#50]: https://github.com/fedify-dev/hollo/issues/50
[#110]: https://github.com/fedify-dev/hollo/pull/110
[#111]: https://github.com/fedify-dev/hollo/issues/111
[#114]: https://github.com/fedify-dev/hollo/pull/114
[#115]: https://github.com/fedify-dev/hollo/issues/115
[#120]: https://github.com/fedify-dev/hollo/pull/120
[#121]: https://github.com/fedify-dev/hollo/pull/121
[#122]: https://github.com/fedify-dev/hollo/pull/122
[#126]: https://github.com/fedify-dev/hollo/pull/126
[#130]: https://github.com/fedify-dev/hollo/pull/130
[#136]: https://github.com/fedify-dev/hollo/issues/136
[#137]: https://github.com/fedify-dev/hollo/pull/137
[#149]: https://github.com/fedify-dev/hollo/issues/149
[#152]: https://github.com/fedify-dev/hollo/pull/152
[#155]: https://github.com/fedify-dev/hollo/pull/155
[#156]: https://github.com/fedify-dev/hollo/pull/156


Version 0.5.7
-------------

Released on August 8, 2025.

 -  Upgrade Fedify to 1.4.13, which includes a critical security
    fix [CVE-2025-54888] that addresses an authentication bypass
    vulnerability allowing actor impersonation.  [[CVE-2025-54888]]


Version 0.5.6
-------------

Released on April 29, 2025.

 -  Fixed a bug where voting to a poll which had been shared (boosted) had not
    been sent to the correct recipient.  [[#142]]

 -  Upgrade Fedify to 1.4.10.

[#142]: https://github.com/fedify-dev/hollo/issues/142


Version 0.5.5
-------------

Released on March 23, 2025.

 -  Fixed a bug where private replies were incorrectly delivered to all
    recipients of the original post, regardless of visibility settings.

 -  Improved privacy for direct messages by preventing delivery through
    shared inboxes.


Version 0.5.4
-------------

Released on February 26, 2025.

 -  Fixed a bug where custom emojis in the display name and bio had not been
    rendered correctly from other software including Mitra.

 -  Upgrade Fedify to 1.4.4.


Version 0.5.3
-------------

Released on February 22, 2025.

 -  Fixed a bug where when an account profile had been updated, the `Update`
    activity had been made with no `assertionMethods` field, which had caused
    interoperability issues with Mitra.

 -  Upgrade Fedify to 1.4.3.


Version 0.5.2
-------------

Released on February 20, 2025.

-  Fixed a bug where the `follows.follower_id` column had not referenced the
    `accounts.id` column.  [[#112]]

 -  Fixed a bug where `GET /api/v1/notifications` had returned server errors
    with some filters.  [[#113]]

 -  Fixed a bug where the federation dashboard had not shown due to server
    errors when an instance had just been set up.

 -  Upgrade Fedify to 1.4.2.


Version 0.5.1
-------------

Released on February 14, 2025.

 -  Fixed a bug where `GET /api/v1/accounts/:id/statuses` had tried to fetch
    remote posts for local accounts.  [[#107]]


Version 0.5.0
-------------

Released on February 12, 2025.

 -  The number of shares and likes became more accurate.

     -  The `Note` objects now have `shares` and `likes` collections with
        their `totalItems` numbers.
     -  When a remote `Note` is persisted, now the `totalItems` numbers of
        `shares` and `likes` are also persisted.
     -  When a `Announce(Note)` or `Undo(Announce(Note))` activity is received,
        now it is forwarded to the followers as well if the activity is signed.

 -  Added [`GET /api/v1/mutes`] API to Mastodon comapatiblity layer.  This API
    returns a list of accounts that are muted by the authenticated user.
    [[#103]]

 -  Added [`GET /api/v1/blocks`] API to Mastodon comapatiblity layer.  This API
    returns a list of accounts that are blocked by the authenticated user.
    [[#103]]

 -  On profile page, backward pagination (newer posts) is now available.
    [[#104], [#105] by Okuto Oyama]

 -  On profile page, images are no more captioned using `<figcaption>` but
    use only `alt` attribute for accessibility.  [[#99], [#100] by Okuto Oyama]

 -  Fixed a style bug where horizontal scrolling occurred when the screen
    size was reduced when there were many custom fields on profile page.
    [[#106] by Okuto Oyama]

 -  Added `ALLOW_HTML` environment variable to allow raw HTML inside Markdown.
    This is useful for allowing users to use broader formatting options outside
    of Markdown, but to avoid XSS attacks, it is still limited to a subset of
    HTML tags and attributes.

 -  On profile page, the favicon is now switched between light and dark mode
    according to the user's preference.  [[#101]]

 -  The `S3_REGION` environment variable became required if `DRIVE_DISK` is set
    to `s3`.  [[#95]]

[#95]: https://github.com/fedify-dev/hollo/issues/95
[#99]: https://github.com/fedify-dev/hollo/issues/99
[#100]: https://github.com/fedify-dev/hollo/pull/100
[#101]: https://github.com/fedify-dev/hollo/issues/101
[#103]: https://github.com/fedify-dev/hollo/issues/103
[#104]: https://github.com/fedify-dev/hollo/issues/104
[#105]: https://github.com/fedify-dev/hollo/pull/105
[#106]: https://github.com/fedify-dev/hollo/pull/106
[`GET /api/v1/mutes`]: https://docs.joinmastodon.org/methods/mutes/#get
[`GET /api/v1/blocks`]: https://docs.joinmastodon.org/methods/blocks/#get


Version 0.4.12
--------------

Released on August 8, 2025.

 -  Upgrade Fedify to 1.3.20, which includes a critical security
    fix [CVE-2025-54888] that addresses an authentication bypass
    vulnerability allowing actor impersonation.  [[CVE-2025-54888]]


Version 0.4.11
--------------

Released on March 23, 2025.

 -  Fixed a bug where private replies were incorrectly delivered to all
    recipients of the original post, regardless of visibility settings.

 -  Improved privacy for direct messages by preventing delivery through
    shared inboxes.


Version 0.4.10
--------------

Released on February 26, 2025.

 -  Fixed a bug where custom emojis in the display name and bio had not been
    rendered correctly from other software including Mitra.

 -  Upgrade Fedify to 1.3.11.


Version 0.4.9
-------------

Released on February 22, 2025.

 -  Fixed a bug where when an account profile had been updated, the `Update`
    activity had been made with no `assertionMethods` field, which had caused
    interoperability issues with Mitra.

 -  Upgrade Fedify to 1.3.10.


Version 0.4.8
-------------

Released on February 20, 2025.

 -  Fixed a bug where the `follows.follower_id` column had not referenced the
    `accounts.id` column.  [[#112]]

 -  Fixed a bug where `GET /api/v1/notifications` had returned server errors
    with some filters.  [[#113]]

 -  Fixed a bug where the federation dashboard had not shown due to server
    errors when an instance had just been set up.

 -  Upgrade Fedify to 1.3.9.

[#112]: https://github.com/fedify-dev/hollo/issues/112
[#113]: https://github.com/fedify-dev/hollo/issues/113


Version 0.4.7
-------------

Released on February 14, 2025.

 -  Fixed a bug where `GET /api/v1/accounts/:id/statuses` had tried to fetch
    remote posts for local accounts.  [[#107]]
 -  Upgrade Fedify to 1.3.8.


Version 0.4.6
-------------

Released on February 1, 2025.

 -  Upgrade Fedify to 1.3.7.

 -  Fixed a bug where `LOG_LEVEL` environment variable had not been respected.

 -  Fixed a bug where when `DRIVE_DISK` is set to `fs` and `FS_ASSET_PATH` is
    set to a relative path, Hollo server had failed to start.


Version 0.4.5
-------------

Released on January 31, 2025.

 -  Fixed a bug where the migration dashboard had not been shown correctly
    when the aliases of the account contained an actor whose the server was
    unreachable.  [[#98]]

 -  Fixed a bug where Hollo posts had included unintended extra line breaks
    on Iceshrimp.  [[#88]]

 -  Fixed a bug where importing emojis from remote servers had failed when
    some shortcodes were already in use.  [[#102]]

 -  Upgrade Fedify to 1.3.6.

[#88]: https://github.com/fedify-dev/hollo/issues/88
[#98]: https://github.com/fedify-dev/hollo/issues/98
[#102]: https://github.com/fedify-dev/hollo/issues/102


Version 0.4.4
-------------

Released on January 21, 2025.

 -  Upgrade Fedify to 1.3.4, which includes [security
    fixes][@fedify-dev/fedify#200]. [[CVE-2025-23221]]


Version 0.4.3
-------------

Released on January 11, 2025.

 -  Fixed a bug where mutes with duration had not been expired correctly.
    [[#92]]
 -  Fixed a bug where importing follows from CSV generated by Iceshrimp had
    failed.  [[#85]]

[#92]: https://github.com/fedify-dev/hollo/issues/92
[#85]: https://github.com/fedify-dev/hollo/issues/85


Version 0.4.2
-------------

Released on December 31, 2024.

 -  Prefer IPv6 to IPv4 addresses when connecting to remote servers.


Version 0.4.1
-------------

Released on December 31, 2024.

 -  Upgrade Fedify to 1.3.3.

 -  Fixed an interoperability issue with GoToSocial.


Version 0.4.0
-------------

Released on December 30, 2024.

 -  Hollo is now powered by Node.js 23+ instead of Bun for more efficient
    memory usage.

 -  Added an experimental feature flag `TIMELINE_INBOXES` to store all posts
    visible to your timeline in the database, rather than filtering them
    in real-time as they are displayed.  This is useful for relatively
    larger instances with many incoming posts, but as of now it may have
    several bugs.  It is expected to be the default behavior in the future
    after it is stabilized.

 -  Now you can import and export your data from the administration dashboard
    in CSV format: follows, lists, accounts you muted, accounts you blocked,
    and bookmarks.

 -  You can now make your profile [`discoverable`].

 -  The profile page now shows a user's cover image if they have one.

 -  Added `GET /api/v1/statuses/:id/reblogged_by` API to Mastodon comapatiblity
    layer.  This API returns a list of accounts that have shared a post.

 -  Fixed a bug where a server error occurred when an invalid UUID was input via
    URL or form data.  [[#65]]

 -  Fixed a bug where the same post could be shared multiple times by the same
    account.

 -  Added `LOG_FILE` environment variable to specify the file path to write
    structured logs.  The logs are written in JSON Lines format.

 -  Improved the performance of recipients gathering during sending activities.

 -  For the sake of concision, now log sink for Sentry is removed.

[`discoverable`]: https://docs.joinmastodon.org/spec/activitypub/#discoverable
[#65]: https://github.com/fedify-dev/hollo/issues/65


Version 0.3.11
--------------

Released on August 8, 2025.

 -  Upgrade Fedify to 1.3.20, which includes a critical security
    fix [CVE-2025-54888] that addresses an authentication bypass
    vulnerability allowing actor impersonation.  [[CVE-2025-54888]]

[CVE-2025-54888]: https://github.com/fedify-dev/fedify/security/advisories/GHSA-6jcc-xgcr-q3h4


Version 0.3.10
--------------

Released on March 23, 2025.

 -  Fixed a bug where private replies were incorrectly delivered to all
    recipients of the original post, regardless of visibility settings.

 -  Improved privacy for direct messages by preventing delivery through
    shared inboxes.


Version 0.3.9
-------------

Released on February 26, 2025.

 -  Fixed a bug where custom emojis in the display name and bio had not been
    rendered correctly from other software including Mitra.

 -  Upgrade Fedify to 1.3.11.


Version 0.3.8
-------------

Released on February 22, 2025.

 -  Fixed a bug where when an account profile had been updated, the `Update`
    activity had been made with no `assertionMethods` field, which had caused
    interoperability issues with Mitra.

 -  Upgrade Fedify to 1.3.10.


Version 0.3.7
-------------

Released on February 14, 2025.

 -  Fixed a bug where `GET /api/v1/accounts/:id/statuses` had tried to fetch
    remote posts for local accounts.  [[#107]]
 -  Upgrade Fedify to 1.3.8.

[#107]: https://github.com/fedify-dev/hollo/issues/107


Version 0.3.6
-------------

Released on January 21, 2025.

 -  Upgrade Fedify to 1.3.4, which includes [security
    fixes][@fedify-dev/fedify#200]. [[CVE-2025-23221]]

[@fedify-dev/fedify#200]: https://github.com/fedify-dev/fedify/discussions/200
[CVE-2025-23221]: https://github.com/fedify-dev/fedify/security/advisories/GHSA-c59p-wq67-24wx


Version 0.3.5
-------------

Released on December 28, 2024.

 -  Fixed a bug where validation check for the account username had not been
    performed correctly.  [[#80]]

 -  Documented the `TZ` environment variable.  [[#82]]

[#80]: https://github.com/fedify-dev/hollo/issues/80
[#82]: https://github.com/fedify-dev/hollo/issues/82


Version 0.3.4
-------------

Released on December 20, 2024.

 -  Fixed a bug where deleting a post had not been propagated to the
    peers.


Version 0.3.3
-------------

Released on December 19, 2024.

 -  Fixed a bug where generated thumbnails had been cropped incorrectly
    if the original image had not the EXIF orientation metadata.  [[#76]]


Version 0.3.2
-------------

Released on December 18, 2024.

 -  Fixed a bug where generated thumbnails had not copied the EXIF orientation
    metadata from the original image.  [[#76]]

 -  Fixed a bug where looking up remote Hubzilla actors and objects had failed.
    [[#78]]

 -  Upgrade Fedify to 1.3.2.

[#76]: https://github.com/fedify-dev/hollo/issues/76
[#78]: https://github.com/fedify-dev/hollo/issues/78


Version 0.3.1
-------------

Released on December 13, 2024.

 -  Fixed a bug where `Undo(Like)` activities on a `Question` object had not
    been handled correctly.

 -  Fixed a bug where `EmojiReact` activities on a `Question` object had not
    been handled correctly.

 -  Fixed a bug where `Undo(EmojiReact)` activities on a `Question` object had
    not been handled correctly.


Version 0.3.0
-------------

Released on December 1, 2024.

 -  Added support for local filesystem storage for media files.
    You can now configure `DRIVE_DISK=fs` and `FS_ASSET_PATH` to store media
    files in the local filesystem.  [[#59]]

     -  Added `DRIVE_DISK` environment variable.
     -  Added `FS_ASSET_PATH` environment variable.
     -  Added `ASSET_URL_BASE` environment variable to replace `S3_URL_BASE`.
     -  Deprecated `S3_URL_BASE` environment variable in favor of
        `ASSET_URL_BASE`.

 -  Added support for Sentry.

     -  Added `SENTRY_DSN` environment variable.

 -  Added pagination to the profile page.  [[#40]]

 -  Upgrade Fedify to 1.3.0.

[#40]: https://github.com/fedify-dev/hollo/issues/40
[#59]: https://github.com/fedify-dev/hollo/pull/59


Version 0.2.4
-------------

Released on December 13, 2024.

 -  Fixed a bug where `Undo(Like)` activities on a `Question` object had not
    been handled correctly.

 -  Fixed a bug where `EmojiReact` activities on a `Question` object had not
    been handled correctly.

 -  Fixed a bug where `Undo(EmojiReact)` activities on a `Question` object had
    not been handled correctly.


Version 0.2.3
-------------

Released on November 22, 2024.

 -  Fixed a bug where followees and followers that had not been approved
    follow requests had been shown in the followees and followers lists.

 -  Fixed a bug where followees and followers had been listed in the wrong
    order in the followees and followers lists.  [[#71]]

 -  Upgrade Fedify to 1.2.7.

[#71]: https://github.com/fedify-dev/hollo/issues/71


Version 0.2.2
-------------

Released on November 7, 2024.

 -  Fixed a bug where replies without mention had not shown up in
    the notifications.  [[#62]]

[#62]: https://github.com/fedify-dev/hollo/issues/62


Version 0.2.1
-------------

Released on November 4, 2024.

 -  Fixed a bug where posts from some ActivityPub software (e.g., Misskey,
    Sharkey, Akkoma) had empty `url` fields, causing them to be displayed
    incorrectly in client apps.  [[#58]]


Version 0.2.0
-------------

Released on November 3, 2024.

 -  Dropped support for Redis.

 -  Added two-factor authentication support.  [[#38]]

 -  Custom emojis now can be deleted from the administration dashboard.

 -  Renamed the *Data* menu from the administration dashboard to *Federation*.

     -  Now posts also can be force-refreshed.
     -  Now the number of messages in the task queue is shown.

 -  Added support for reporting remote accounts and posts.
    [[#41] by Emelia Smith]

 -  Improved alignment on Mastodon API changes about OAuth and apps.
    [[#43] by Emelia Smith]

     -  `GET /api/v1/apps/verify_credentials` no longer requires `read` scope,
        just a valid access token (or client credential).
     -  `POST /api/v1/apps` now supports multiple redirect URIs.
     -  `redirect_uri` is deprecated, but software may still rely on it until
        they switch to `redirect_uris`.
     -  Expose `redirect_uri`, `redirect_uris`, and `scopes` to verify
        credentials for apps.

 -  Added support for RFC 8414 for OAuth Authorization Server metadata endpoint.
    [[#47] by Emelia Smith]

 -  On creating a new account, the user now can choose to follow the official
    Hollo account.

 -  Added a favicon.

 -  Added `PORT` and `ALLOW_PRIVATE_ADDRESS` environment variables.
    [[#53] by Helge Krueger]

[#38]: https://github.com/fedify-dev/hollo/issues/38
[#41]: https://github.com/fedify-dev/hollo/pull/41
[#43]: https://github.com/fedify-dev/hollo/pull/43
[#47]: https://github.com/fedify-dev/hollo/pull/47
[#53]: https://github.com/fedify-dev/hollo/pull/53


Version 0.1.7
-------------

Released on November 4, 2024.

 -  Fixed a bug where posts from some ActivityPub software (e.g., Misskey,
    Sharkey, Akkoma) had empty `url` fields, causing them to be displayed
    incorrectly in client apps.  [[#58]]

[#58]: https://github.com/fedify-dev/hollo/issues/58


Version 0.1.6
-------------

Released on October 30, 2024.

 -  Fixed a bug where followers-only posts from accounts that had had set
    their follower lists to private had been recognized as direct messages.
    Even after upgrading to this version, such accounts need to be force-refreshed
    from the administration dashboard to fix the issue.

 -  Fixed the federated (public) timeline showing the shared posts from
    the blocked or muted accounts.

 -  Fixed the list timeline showing the shared posts from the blocked or muted
    accounts.


Version 0.1.5
-------------

Released on October 30, 2024.

 -  Fixed the profile page showing the shared posts from the blocked or muted
    accounts.


Version 0.1.4
-------------

Released on October 30, 2024.

 -  Fixed the home timeline showing the shared posts from the blocked or muted
    accounts.


Version 0.1.3
-------------

Released on October 27, 2024.

 -  Fixed incorrect handling of relative path URIs in `Link` headers with
    `rel=alternate`.  This caused inoperability with some software such as
    GoToSocial.
 -  It now sends `Delete(Person)` activity to followees besides followers
    when a user deletes their account.


Version 0.1.2
-------------

Released on October 24, 2024.

 -  Fixed the last page in the profile using Moshidon leading to infinite
    pagination.  [[#48] by  Emelia Smith]

[#48]: https://github.com/fedify-dev/hollo/issues/48


Version 0.1.1
-------------

Released on October 24, 2024.

 -  Upgrade Fedify to 1.1.1.


Version 0.1.0
-------------

Released on October 22, 2024.  Initial release.

<!-- cSpell: ignore Hyeonseo -->
