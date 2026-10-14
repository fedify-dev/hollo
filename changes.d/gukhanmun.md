---
priority: -60
---
 -  Replaced the undocumented `SEONBI_URL` integration with the embedded
    [Gukhanmun] Node-API binding.  Set `GUKHANMUN` to a comma-separated list of
    locale patterns, such as `ko,ko-*`, to add Hangul readings to Hanja in
    matching local posts.  Patterns can contain `*` wildcards.  Posts with a
    `KP` region subtag use North Korean readings.  Seonbi's broader punctuation
    transformations are no longer applied.

[Gukhanmun]: https://gukhanmun.org/
