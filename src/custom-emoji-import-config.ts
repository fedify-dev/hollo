const MEBIBYTE = 1024 * 1024;

function readPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw == null) {
    return defaultValue;
  }

  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }

  return value;
}

export const EMOJI_IMPORT_MAX_ARCHIVE_BYTES = readPositiveInteger(
  "EMOJI_IMPORT_MAX_ARCHIVE_BYTES",
  50 * MEBIBYTE,
);

export const EMOJI_IMPORT_MAX_ENTRY_COUNT = readPositiveInteger(
  "EMOJI_IMPORT_MAX_ENTRY_COUNT",
  1_000,
);

export const EMOJI_IMPORT_MAX_EXTRACTED_BYTES = readPositiveInteger(
  "EMOJI_IMPORT_MAX_EXTRACTED_BYTES",
  250 * MEBIBYTE,
);
