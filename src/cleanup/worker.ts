import type { CleanupJobItem } from "../schema";
import { processCleanupItem } from "./processors";

export async function executeCleanupItem(
  item: CleanupJobItem,
  check: () => Promise<void>,
  dispatch: () => Promise<void>,
) {
  await processCleanupItem(item, check, dispatch);
}
