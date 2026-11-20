---
title: 搜尋
description: >-
  Hollo 支援進階搜尋查詢，可以使用各種運算子按作者、內容、附件、日期範圍等
  篩選貼文。
---

Hollo 提供了一個搜尋功能，允許您使用各種運算子查找貼文。您可以使用這些
運算子按作者、內容、附件、日期範圍等篩選貼文。


運作原理
--------

Hollo 的搜尋使用 PostgreSQL 的 `ILIKE` 運算子進行模式比對，而不是專用的
全文搜尋引擎。這意味著：

 -  **不區分大小寫**：搜尋不區分大小寫，因此 `Hello` 會比對 `hello`、
    `HELLO` 等。
 -  **模式比對**：搜尋詞會比對貼文內容的任何部分，而不僅僅是完整的單字。
 -  **效能考量**：由於沒有全文索引，隨著貼文數量的增加，搜尋速度可能會
    變慢。對於小型到中型實例，這應該不會有明顯影響。


支援的運算子
------------

### 內容篩選

#### `has:media`

查找包含媒體附件（圖片、影片、音訊）的貼文。

~~~~
has:media
~~~~

#### `has:poll`

查找包含投票的貼文。

~~~~
has:poll
~~~~

### 貼文特性

#### `is:reply`

查找作為其他貼文回覆的貼文。

~~~~
is:reply
~~~~

#### `is:sensitive`

查找被標記為敏感的貼文。

~~~~
is:sensitive
~~~~

### 作者和提及

#### `from:username`

查找來自特定用戶的貼文。您可以使用各種格式：

~~~~
from:alice
from:@alice
from:alice@example.com
from:@alice@example.com
~~~~

用戶名比對是精確的，因此 `from:alice` 只會比對用戶名正好是 `alice` 的用戶，
而不會比對 `alice123` 或 `alicewonder`。

使用 `from:me` 搜尋目前登入帳號的貼文。例如，`from:me has:media`
會找出自己附有媒體的貼文。若要找用戶名為 `me` 的帳號所發的貼文，
請使用 `from:@me`。

#### `mentions:username`

使用用戶名或含網域的完整帳號名稱，查找提及特定用戶的貼文。

~~~~
mentions:bob
mentions:bob@example.com
~~~~

### 語言篩選

#### `language:xx`

查找用特定語言撰寫的貼文。使用 [ISO 639-1] 語言代碼。

~~~~
language:en
language:ko
language:ja
~~~~

[ISO 639-1]: https://zh.wikipedia.org/wiki/ISO_639-1%E4%BB%A3%E7%A0%81%E8%A1%A8

### 日期篩選

#### `before:YYYY-MM-DD`

查找在指定日期之前發布的貼文。**不包括該日期本身。**

~~~~
before:2024-06-15
~~~~

#### `after:YYYY-MM-DD`

查找在指定日期當天或之後發布的貼文。**包括該日期本身。**

~~~~
after:2024-01-01
~~~~


組合運算子
----------

### 隱式 AND

多個運算子或搜尋詞透過隱式 AND 組合。所有條件都必須符合。

~~~~
from:alice has:media
~~~~

這會查找來自 `alice` 且有媒體附件的貼文。

### OR 運算子

使用 `OR`（必須大寫）來查找符合至少一個條件的貼文。

~~~~
has:media OR has:poll
~~~~

這會查找有媒體附件或有投票的貼文。

### 否定

在任何運算子或搜尋詞前加上 `-` 來排除符合的貼文。

~~~~
-has:media
-is:sensitive
-from:spammer
~~~~

這對於過濾不需要的內容很有用。

### 括號

使用括號來分組條件並控制優先順序。

~~~~
(from:alice OR from:bob) has:poll
~~~~

這會查找來自 `alice` 或 `bob` 且有投票的貼文。

如果沒有括號，AND 的優先順序高於 OR：

~~~~
from:alice has:poll OR from:bob
~~~~

這等同於 `(from:alice has:poll) OR from:bob`，會查找來自 `alice` 且有
投票的貼文，或者來自 `bob` 的任何貼文。

### 引號字串

使用雙引號或單引號來搜尋包含空格的片語。

~~~~
"hello world"
'exact phrase'
~~~~


複雜查詢範例
------------

### 來自多個用戶且有附件的貼文

~~~~
(from:alice OR from:bob OR from:charlie) has:media
~~~~

### 特定語言的近期貼文

~~~~
language:ko after:2024-01-01
~~~~

### 排除敏感內容

~~~~
from:alice -is:sensitive
~~~~

### 日期範圍內的貼文

~~~~
after:2024-06-01 before:2024-07-01
~~~~

### 組合多個條件的複雜篩選

~~~~
(has:media OR has:poll) language:en -is:sensitive after:2024-01-01
~~~~

這會查找 2024 年以後發布的、有媒體或投票的英語貼文，排除敏感內容。
