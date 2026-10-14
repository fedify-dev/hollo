---
priority: -120
links:
  '#524': https://github.com/fedify-dev/hollo/issues/524
  '#526': https://github.com/fedify-dev/hollo/pull/526
---
 -  Added WebP (`image/webp`) as an accepted format for profile avatar and
    banner image uploads.  Previously only JPEG, PNG, and GIF were accepted
    by both the Mastodon-compatible
    `PATCH /api/v1/accounts/update_credentials` endpoint and the admin
    account creation and editing forms, even though WebP is supported
    elsewhere in Hollo.  [[#524], [#526] by naskya]
