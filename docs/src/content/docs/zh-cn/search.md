---
title: 搜索
description: >-
  Hollo支持高级搜索查询，可以使用各种运算符按作者、内容、附件、日期范围等
  筛选帖子。
---

Hollo提供了一个搜索功能，允许您使用各种运算符查找帖子。您可以使用这些
运算符按作者、内容、附件、日期范围等筛选帖子。


工作原理
--------

Hollo的搜索使用PostgreSQL的`ILIKE`运算符进行模式匹配，而不是专用的
全文搜索引擎。这意味着：

 -  **不区分大小写**: 搜索不区分大小写，因此`Hello`会匹配`hello`、
    `HELLO`等。
 -  **模式匹配**: 搜索词会匹配帖子内容的任何部分，而不仅仅是完整的单词。
 -  **性能考虑**: 由于没有全文索引，随着帖子数量的增加，搜索速度可能会
    变慢。对于小型到中型实例，这应该不会有明显影响。


支持的运算符
------------

### 内容筛选

#### `has:media`

查找包含媒体附件（图片、视频、音频）的帖子。

~~~
has:media
~~~

#### `has:poll`

查找包含投票的帖子。

~~~
has:poll
~~~


### 帖子特性

#### `is:reply`

查找作为其他帖子回复的帖子。

~~~
is:reply
~~~

#### `is:sensitive`

查找被标记为敏感的帖子。

~~~
is:sensitive
~~~


### 作者和提及

#### `from:username`

查找来自特定用户的帖子。您可以使用各种格式：

~~~
from:alice
from:@alice
from:alice@example.com
from:@alice@example.com
~~~

用户名匹配是精确的，因此`from:alice`只会匹配用户名正好是`alice`的用户，
而不会匹配`alice123`或`alicewonder`。

#### `mentions:username`

查找提及特定用户的帖子。支持与`from:`相同的格式。

~~~
mentions:bob
mentions:bob@example.com
~~~


### 语言筛选

#### `language:xx`

查找用特定语言撰写的帖子。使用[ISO 639-1]语言代码。

~~~
language:en
language:ko
language:ja
~~~

[ISO 639-1]: https://zh.wikipedia.org/wiki/ISO_639-1%E4%BB%A3%E7%A0%81%E8%A1%A8


### 日期筛选

#### `before:YYYY-MM-DD`

查找在指定日期之前发布的帖子。**不包括该日期本身。**

~~~
before:2024-06-15
~~~

#### `after:YYYY-MM-DD`

查找在指定日期当天或之后发布的帖子。**包括该日期本身。**

~~~
after:2024-01-01
~~~


组合运算符
----------

### 隐式AND

多个运算符或搜索词通过隐式AND组合。所有条件都必须匹配。

~~~
from:alice has:media
~~~

这会查找来自`alice`且有媒体附件的帖子。


### OR运算符

使用`OR`（必须大写）来查找满足至少一个条件的帖子。

~~~
has:media OR has:poll
~~~

这会查找有媒体附件或有投票的帖子。


### 否定

在任何运算符或搜索词前加上`-`来排除匹配的帖子。

~~~
-has:media
-is:sensitive
-from:spammer
~~~

这对于过滤不需要的内容很有用。


### 括号

使用括号来分组条件并控制优先级。

~~~
(from:alice OR from:bob) has:poll
~~~

这会查找来自`alice`或`bob`且有投票的帖子。

如果没有括号，AND的优先级高于OR：

~~~
from:alice has:poll OR from:bob
~~~

这等同于`(from:alice has:poll) OR from:bob`，会查找来自`alice`且有
投票的帖子，或者来自`bob`的任何帖子。


### 引号字符串

使用双引号或单引号来搜索包含空格的短语。

~~~
"hello world"
'exact phrase'
~~~


复杂查询示例
------------

### 来自多个用户且有附件的帖子

~~~
(from:alice OR from:bob OR from:charlie) has:media
~~~

### 特定语言的最近帖子

~~~
language:ko after:2024-01-01
~~~

### 排除敏感内容

~~~
from:alice -is:sensitive
~~~

### 日期范围内的帖子

~~~
after:2024-06-01 before:2024-07-01
~~~

### 组合多个条件的复杂筛选

~~~
(has:media OR has:poll) language:en -is:sensitive after:2024-01-01
~~~

这会查找2024年以后发布的、有媒体或投票的英语帖子，排除敏感内容。
