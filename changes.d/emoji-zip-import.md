---
links:
  '#686': https://github.com/fedify-dev/hollo/issues/686
  '#688': https://github.com/fedify-dev/hollo/pull/688
---
 -  Added support for importing custom emojis from Misskey packed emoji ZIP
    archives in the administration dashboard.  Configure either
    `EMOJI_IMPORT_FS_PATH` or `S3_EMOJI_IMPORT_BUCKET` to enable temporary
    archive storage.  The import limits default to 50 MiB
    (`EMOJI_IMPORT_MAX_ARCHIVE_BYTES`), 1,000 entries
    (`EMOJI_IMPORT_MAX_ENTRY_COUNT`), and 250 MiB extracted
    (`EMOJI_IMPORT_MAX_EXTRACTED_BYTES`).  [[#686], [#688] by nove-b]
