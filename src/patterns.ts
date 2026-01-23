/**
 * Regular expression pattern for matching WebFinger handles.
 *
 * Matches formats like:
 * - `@user@domain.tld`
 * - `user@domain.tld`
 *
 * Note: This pattern uses the `u` flag for Unicode support, but NOT the `g`
 * flag to avoid issues with `test()` being stateful on global regexes.
 */
export const HANDLE_PATTERN =
  /^@?[\p{L}\p{N}._-]+@(?:[\p{L}\p{N}][\p{L}\p{N}_-]*\.)+[\p{L}\p{N}]{2,}$/u;
