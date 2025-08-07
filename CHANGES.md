Hollo changelog
===============

Version 0.3.12
--------------

To be released.


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


Version 0.3.6
-------------

Released on January 21, 2025.

 -  Upgrade Fedify to 1.3.4, which includes [security
    fixes][@fedify-dev/fedify#200] [[CVE-2025-23221]]

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
