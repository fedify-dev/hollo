import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueue,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase, getFixtureFile } from "../tests/helpers";
import { registerCustomEmojiImports } from "./custom-emoji-import-tasks";
import db from "./db";
import { customEmojiImportJobs } from "./schema";
import { drive } from "./storage";
import { uuidv7 } from "./uuid";

class TestQueue implements MessageQueue {
  messages: Message[] = [];

  async enqueue(
    message: Message,
    _options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    this.messages.push(message);
  }

  async listen(): Promise<void> {}
}

function fixture() {
  const queue = new TestQueue();

  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });

  const tasks = registerCustomEmojiImports(federation);

  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );

  return {
    tasks,
    ctx,
    run: () => federation.processQueuedTask(undefined, queue.messages.shift()!),
  };
}

describe("Custom emoji import tasks", () => {
  beforeEach(cleanDatabase);

  afterEach(() => {
    drive.restore();
    drive.restore("emojiImports");
  });

  it("imports an emoji from a Misskey packed emoji archive", async () => {
    expect.assertions(4);

    const imageDisk = drive.fake();
    const archiveDisk = drive.fake("emojiImports");

    const image = new Uint8Array(
      await (await getFixtureFile("emoji.png", "image/png")).arrayBuffer(),
    );

    const archive = zipSync({
      "emoji-pack/meta.json": strToU8(
        JSON.stringify({
          metaVersion: 1,
          host: "",
          exportedAt: "2026-10-29T00:00:00.000Z",
          emojis: [
            {
              downloaded: true,
              fileName: "cat.png",
              emoji: {
                name: "cat",
                category: "animals",
              },
            },
          ],
        }),
      ),
      "emoji-pack/cat.png": image,
    });

    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;

    await archiveDisk.put(archiveKey, archive);

    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "pending",
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });

    expect(job).toMatchObject({
      status: "completed",
      importedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });

    const emoji = await db.query.customEmojis.findFirst({
      where: { shortcode: { eq: "cat" } },
    });

    expect(emoji).toMatchObject({
      shortcode: "cat",
      category: "animals",
      url: "http://hollo.test/assets/emojis/cat.png",
    });

    expect(() => imageDisk.assertExists("emojis/cat.png")).not.toThrow();

    expect(() => archiveDisk.assertMissing(archiveKey)).not.toThrow();
  });
});
