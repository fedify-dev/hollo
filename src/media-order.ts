import type { Medium } from "./schema";

export function orderMedia<T extends Medium>(media: readonly T[]): T[] {
  return media.toSorted(
    (left, right) =>
      left.position - right.position ||
      left.created.getTime() - right.created.getTime() ||
      left.id.localeCompare(right.id),
  );
}
