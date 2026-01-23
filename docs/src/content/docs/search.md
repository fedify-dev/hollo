---
title: Search
description: >-
  Hollo supports advanced search queries with various operators to filter
  posts by author, content, attachments, date ranges, and more.
---

Hollo provides a search feature that allows you to find posts using various
operators.  You can use these operators to filter posts by author, content,
attachments, date ranges, and more.


How it works
------------

Hollo's search uses PostgreSQL's `ILIKE` operator for pattern matching,
rather than a dedicated full-text search engine.  This means:

 -  **Case-insensitive matching**: Searches are case-insensitive, so
    `Hello` matches `hello`, `HELLO`, etc.
 -  **Pattern matching**: The search term matches any part of the post
    content, not just whole words.
 -  **Performance considerations**: Since there's no full-text index,
    searches may become slower as your post volume grows.  For small to
    medium-sized instances, this should not be noticeable.


Supported operators
-------------------

### Content filters

#### `has:media`

Finds posts that contain media attachments (images, videos, audio).

~~~
has:media
~~~

#### `has:poll`

Finds posts that contain polls.

~~~
has:poll
~~~


### Post characteristics

#### `is:reply`

Finds posts that are replies to other posts.

~~~
is:reply
~~~

#### `is:sensitive`

Finds posts that are marked as sensitive.

~~~
is:sensitive
~~~


### Author and mentions

#### `from:username`

Finds posts from a specific user.  You can use various formats:

~~~
from:alice
from:@alice
from:alice@example.com
from:@alice@example.com
~~~

The username matching is exact, so `from:alice` will only match users whose
username is exactly `alice`, not `alice123` or `alicewonder`.

#### `mentions:username`

Finds posts that mention a specific user.  Supports the same formats as
`from:`.

~~~
mentions:bob
mentions:bob@example.com
~~~


### Language filter

#### `language:xx`

Finds posts written in a specific language.  Use [ISO 639-1] language codes.

~~~
language:en
language:ko
language:ja
~~~

[ISO 639-1]: https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes


### Date filters

#### `before:YYYY-MM-DD`

Finds posts published before the specified date.  **The date itself is not
included.**

~~~
before:2024-06-15
~~~

#### `after:YYYY-MM-DD`

Finds posts published on or after the specified date.  **The date itself is
included.**

~~~
after:2024-01-01
~~~


Combining operators
-------------------

### Implicit AND

Multiple operators or search terms are combined with implicit AND.
All conditions must match.

~~~
from:alice has:media
~~~

This finds posts from `alice` that also have media attachments.


### OR operator

Use `OR` (must be uppercase) to match posts that satisfy at least one of
the conditions.

~~~
has:media OR has:poll
~~~

This finds posts that have either media attachments or polls.


### Negation

Prefix any operator or search term with `-` to exclude matching posts.

~~~
-has:media
-is:sensitive
-from:spammer
~~~

This is useful for filtering out unwanted content.


### Parentheses

Use parentheses to group conditions and control precedence.

~~~
(from:alice OR from:bob) has:poll
~~~

This finds posts with polls from either `alice` or `bob`.

Without parentheses, AND has higher precedence than OR:

~~~
from:alice has:poll OR from:bob
~~~

This is equivalent to `(from:alice has:poll) OR from:bob`, which finds
either posts with polls from `alice`, or any posts from `bob`.


### Quoted strings

Use double or single quotes to search for phrases containing spaces.

~~~
"hello world"
'exact phrase'
~~~


Complex query examples
----------------------

### Posts from multiple users with attachments

~~~
(from:alice OR from:bob OR from:charlie) has:media
~~~

### Recent posts in a specific language

~~~
language:ko after:2024-01-01
~~~

### Excluding sensitive content

~~~
from:alice -is:sensitive
~~~

### Posts within a date range

~~~
after:2024-06-01 before:2024-07-01
~~~

### Complex filter combining multiple conditions

~~~
(has:media OR has:poll) language:en -is:sensitive after:2024-01-01
~~~

This finds English posts from 2024 onwards that have either media or polls,
excluding sensitive content.
