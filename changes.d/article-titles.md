---
priority: -30
links:
  '#646': https://github.com/fedify-dev/hollo/issues/646
  '#650': https://github.com/fedify-dev/hollo/pull/650
---
 -  Titles of incoming ActivityPub `Article` objects, such as posts from
    blogging platforms, are now preserved instead of being dropped.  The title
    is shown as a heading above the post body on Hollo's web pages, and
    Mastodon-compatible clients receive it as an `<h2>` heading prepended to
    the status `content`.  Articles received before this change get their
    titles when they are updated by their author or refreshed.  [[#646], [#650]]
