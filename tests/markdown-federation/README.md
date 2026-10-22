Markdown federation acceptance tests
====================================

Run *scripts/test-markdown-federation.ts* against three disposable servers to
check actual HTTP inbox delivery.  The runner creates one public post per
extension, checks the saved Markdown and rendered Hollo HTML, waits for both
receivers to store the post, then edits it and checks each receiver again.
It queries account timelines and stored receiver IDs, without resolving post
URLs that could fetch missing activities on demand.  Posts are deleted in
cleanup; the receiver accounts continue following the sender.

This is an API and federation check.  It does not establish browser rendering,
keyboard, touch, screen-reader behavior, or compatibility with other API
clients.  Those checks remain pending before release.


Run the tests
-------------

Use a Hollo checkout with all ten `MARKDOWN_EXTENSIONS` enabled and one local
account.  Prepare one account each on Mastodon and Misskey, with federation
enabled, and run their delivery workers.  Use tokens that can read, post, and
follow.  All three servers must resolve each other's canonical HTTPS origins
and trust their certificates.  Use canonical HTTPS port 443, as in the recorded
run.

Copy *config.example.json* to a private file outside the checkout, replace the
origins and tokens, and restrict its permissions:

~~~~ bash
chmod 600 /path/to/private-config.json
mise exec -- pnpm exec tsx scripts/test-markdown-federation.ts \
  --config /path/to/private-config.json \
  --report /path/to/receiver-results.json
~~~~

The default expectation is that both receivers apply edits.  Set
`misskeyNoteUpdates` to `ignored` only for Misskey 2026.10.0, whose handler does
not support `Update(Note)`.  In that mode the runner checks that the original
text remains after a five-second observation window.  Check the receiver's
inbox logs separately to distinguish ignored delivery from delayed or missing
delivery.  The recorded run below includes that log evidence.

The runner fails if Hollo does not render an extension, visible fallback text
disappears, a receiver does not store a post or apply an expected edit, or
cleanup fails.
Its JSON report contains versions, Markdown source, object URIs, receiver IDs,
and the Hollo HTML, Mastodon HTML, and Misskey MFM before and after editing.
It omits tokens.  A failed run writes its partial results and error too.


Recorded run
------------

On 23 October 2026 (KST), the runner exercised Hollo 0.10.0 at
`a4867ed6beb849b7cebe04f6ea71afa89ff8871b` against unmodified official images:

| Receiver | Version   | Image digest                                                                                        |
| -------- | --------- | --------------------------------------------------------------------------------------------------- |
| Mastodon | 4.7.3     | `ghcr.io/mastodon/mastodon@sha256:e013a8b5c0be1e5a204791d3be7b1be544026cb5ca28ed3dfff9e69dbf4812a1` |
| Misskey  | 2026.10.0 | `docker.io/misskey/misskey@sha256:17fad0b0607cafb57c08da72e1a2b1b9ccee5d3a671b4458536ca580a18d6aae` |

The disposable lab used PostgreSQL 18, Redis 7, Node.js 24.22.0, and Caddy
2.11.2 with a local CA.  The servers communicated through a dedicated rootless
Podman network and canonical port 443.  The CA was trusted only in the test
processes.  Private-address access was enabled only in these isolated
instances.  No global trust store or existing service was changed.

Both receivers stored all ten posts.  Mastodon applied all ten
edits.  Misskey retained every original note: its inbox logged
`skip: Unknown type: Note` for each Update.  The [release's update handler]
supports actor and Question updates, without a Note branch.  Edits therefore do
not reach Misskey 2026.10.0 users.

See *receiver-results.json* for the actual API output and
*misskey-update-log.json* for the matching inbox observations.  Local lab URLs
are evidence identifiers, not publicly accessible posts.  Receiver output was:

| Extension             | Mastodon 4.7.3                                               | Misskey 2026.10.0                                                    |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Footnotes             | Keeps numbers and absolute links; removes local IDs          | Keeps numbers and absolute links in MFM                              |
| Definition lists      | Flattens semantic tags; keeps colon and separation           | Keeps term, colon, and separated definition                          |
| Subscript/superscript | Flattens `H₂O`/`x²` to `H2O`/`x2`                            | Flattens to `H2O`/`x2`                                               |
| Highlight/insertion   | Keeps text, loses marking                                    | Keeps text, loses marking                                            |
| Ruby                  | Retains `ruby`, `rt`, and fallback `rp`                      | Converts the fixture to `$[ruby 漢字 かんじ]`                        |
| Abbreviations         | Keeps visible first-use expansion; drops tooltip             | Keeps visible first-use expansion                                    |
| Task lists            | Keeps list and literal `[x]`/`[ ]`                           | Keeps literal markers in text                                        |
| Math                  | Converts annotations to dollar-delimited TeX, without MathML | Concatenates presentation text and TeX; inline `x^2` becomes `x2x^2` |

These results cover the recorded examples and receiver versions.  They do
not promise that arbitrary ruby, formulas, or clients behave the same way.

[release's update handler]: https://github.com/misskey-dev/misskey/blob/de89118a225fbe0833e42ab94e8d5af1e5211208/packages/backend/src/core/activitypub/ApInboxService.ts#L780-L803
