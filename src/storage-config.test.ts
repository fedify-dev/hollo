import { afterEach, describe, expect, it, vi } from "vitest";

async function loadStorageConfig() {
  vi.resetModules();
  return import("./storage-config");
}

describe("emoji import storage configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rejects using the public S3 bucket for emoji import archives", async () => {
    vi.stubEnv("S3_BUCKET", "public-media");
    vi.stubEnv("S3_EMOJI_IMPORT_BUCKET", "public-media");

    await expect(loadStorageConfig()).rejects.toThrow(
      "S3_EMOJI_IMPORT_BUCKET must differ from S3_BUCKET",
    );
  });

  it.each([
    ["/var/lib/hollo/media", "/var/lib/hollo/media"],
    ["/var/lib/hollo/media", "/var/lib/hollo/media/emoji-imports"],
    ["media", "media/emoji-imports"],
  ])(
    "rejects an emoji import path inside public filesystem storage",
    async (publicPath, importPath) => {
      vi.stubEnv("FS_STORAGE_PATH", publicPath);
      vi.stubEnv("EMOJI_IMPORT_FS_PATH", importPath);

      await expect(loadStorageConfig()).rejects.toThrow(
        "EMOJI_IMPORT_FS_PATH must be outside FS_STORAGE_PATH",
      );
    },
  );

  it("permits an emoji import path outside public filesystem storage", async () => {
    vi.stubEnv("FS_STORAGE_PATH", "/var/lib/hollo/media");
    vi.stubEnv("EMOJI_IMPORT_FS_PATH", "/var/lib/hollo/emoji-imports");

    const config = await loadStorageConfig();
    expect(config.EMOJI_IMPORT_DISK).toBe("fs");
  });
});
