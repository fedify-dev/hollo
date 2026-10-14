---
priority: -100
links:
  '#609': https://github.com/fedify-dev/hollo/issues/609
---
 -  Changed local ActivityPub `Note`, `Question`, and `Article` objects to
    advertise paginated `replies` collections at
    `/@{username}/{id}/replies` instead of embedding replies inline.  The
    collections apply signed-fetch visibility rules so each requester sees
    only replies they are allowed to access.  [[#609]]
