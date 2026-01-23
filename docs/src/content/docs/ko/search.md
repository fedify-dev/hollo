---
title: 검색
description: >-
  Hollo는 다양한 연산자를 사용하여 작성자, 내용, 첨부파일, 날짜 범위 등으로
  게시물을 필터링할 수 있는 고급 검색 쿼리를 지원합니다.
---

Hollo는 다양한 연산자를 사용하여 게시물을 찾을 수 있는 검색 기능을 제공합니다.
이러한 연산자를 사용하여 작성자, 내용, 첨부파일, 날짜 범위 등으로 게시물을
필터링할 수 있습니다.


작동 방식
---------

Hollo의 검색은 전용 전문 검색 엔진 대신 PostgreSQL의 `ILIKE` 연산자를
사용하여 패턴 매칭을 수행합니다.  이는 다음을 의미합니다:

 -  **대소문자 구분 없음**: 검색은 대소문자를 구분하지 않으므로
    `Hello`는 `hello`, `HELLO` 등과 일치합니다.
 -  **패턴 매칭**: 검색어는 전체 단어뿐만 아니라 게시물 내용의
    어느 부분과도 일치합니다.
 -  **성능 고려사항**: 전문 검색 인덱스가 없으므로 게시물 양이 증가함에
    따라 검색 속도가 느려질 수 있습니다.  소규모에서 중규모 인스턴스의
    경우 이것이 눈에 띄지 않을 것입니다.


지원되는 연산자
---------------

### 콘텐츠 필터

#### `has:media`

미디어 첨부파일(이미지, 동영상, 오디오)이 포함된 게시물을 찾습니다.

~~~
has:media
~~~

#### `has:poll`

투표가 포함된 게시물을 찾습니다.

~~~
has:poll
~~~


### 게시물 특성

#### `is:reply`

다른 게시물에 대한 답글인 게시물을 찾습니다.

~~~
is:reply
~~~

#### `is:sensitive`

민감한 것으로 표시된 게시물을 찾습니다.

~~~
is:sensitive
~~~


### 작성자와 멘션

#### `from:username`

특정 사용자의 게시물을 찾습니다.  다양한 형식을 사용할 수 있습니다:

~~~
from:alice
from:@alice
from:alice@example.com
from:@alice@example.com
~~~

사용자명 매칭은 정확히 일치해야 하므로 `from:alice`는 사용자명이
정확히 `alice`인 사용자만 일치하며, `alice123`이나 `alicewonder`는
일치하지 않습니다.

#### `mentions:username`

특정 사용자를 멘션하는 게시물을 찾습니다.  `from:`과 동일한 형식을
지원합니다.

~~~
mentions:bob
mentions:bob@example.com
~~~


### 언어 필터

#### `language:xx`

특정 언어로 작성된 게시물을 찾습니다.  [ISO 639-1] 언어 코드를
사용합니다.

~~~
language:en
language:ko
language:ja
~~~

[ISO 639-1]: https://ko.wikipedia.org/wiki/ISO_639-1_%EC%BD%94%EB%93%9C_%EB%AA%A9%EB%A1%9D


### 날짜 필터

#### `before:YYYY-MM-DD`

지정된 날짜 이전에 게시된 게시물을 찾습니다.  **해당 날짜는 포함되지
않습니다.**

~~~
before:2024-06-15
~~~

#### `after:YYYY-MM-DD`

지정된 날짜 이후에 게시된 게시물을 찾습니다.  **해당 날짜가 포함됩니다.**

~~~
after:2024-01-01
~~~


연산자 결합
-----------

### 암묵적 AND

여러 연산자나 검색어는 암묵적 AND로 결합됩니다.  모든 조건이
일치해야 합니다.

~~~
from:alice has:media
~~~

이것은 미디어 첨부파일이 있는 `alice`의 게시물을 찾습니다.


### OR 연산자

최소 하나의 조건을 만족하는 게시물을 찾으려면 `OR`(대문자여야 함)을
사용합니다.

~~~
has:media OR has:poll
~~~

이것은 미디어 첨부파일이 있거나 투표가 있는 게시물을 찾습니다.


### 부정

일치하는 게시물을 제외하려면 연산자나 검색어 앞에 `-`를 붙입니다.

~~~
-has:media
-is:sensitive
-from:spammer
~~~

원치 않는 콘텐츠를 필터링하는 데 유용합니다.


### 괄호

조건을 그룹화하고 우선순위를 제어하려면 괄호를 사용합니다.

~~~
(from:alice OR from:bob) has:poll
~~~

이것은 `alice` 또는 `bob`의 투표가 있는 게시물을 찾습니다.

괄호가 없으면 AND가 OR보다 우선순위가 높습니다:

~~~
from:alice has:poll OR from:bob
~~~

이것은 `(from:alice has:poll) OR from:bob`과 동일하며, `alice`의
투표가 있는 게시물 또는 `bob`의 모든 게시물을 찾습니다.


### 따옴표로 묶인 문자열

공백이 포함된 구문을 검색하려면 큰따옴표나 작은따옴표를 사용합니다.

~~~
"hello world"
'exact phrase'
~~~


복잡한 쿼리 예시
----------------

### 여러 사용자의 첨부파일이 있는 게시물

~~~
(from:alice OR from:bob OR from:charlie) has:media
~~~

### 특정 언어의 최근 게시물

~~~
language:ko after:2024-01-01
~~~

### 민감한 콘텐츠 제외

~~~
from:alice -is:sensitive
~~~

### 날짜 범위 내의 게시물

~~~
after:2024-06-01 before:2024-07-01
~~~

### 여러 조건을 결합한 복잡한 필터

~~~
(has:media OR has:poll) language:en -is:sensitive after:2024-01-01
~~~

이것은 2024년 이후의 미디어 또는 투표가 있는 영어 게시물을 찾으며,
민감한 콘텐츠는 제외합니다.
