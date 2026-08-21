import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());

vi.mock("@gukhanmun/napi", () => ({ load }));

import { transformPostHtmlWithGukhanmun } from "./gukhanmun";

describe("Gukhanmun failures", () => {
  beforeEach(() => {
    load.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not load Gukhanmun when the locale does not match", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");

    await expect(
      transformPostHtmlWithGukhanmun("<p>漢字</p>", "en"),
    ).resolves.toBe("<p>漢字</p>");
    expect(load).not.toHaveBeenCalled();
  });

  it("propagates converter loading failures", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");
    load.mockRejectedValueOnce(new Error("native addon unavailable"));

    await expect(
      transformPostHtmlWithGukhanmun("<p>漢字</p>", "ko"),
    ).rejects.toThrow("native addon unavailable");
  });

  it("retries converter loading after a failure", async () => {
    vi.stubEnv("GUKHANMUN", "ko,ko-*");
    load
      .mockRejectedValueOnce(new Error("temporary loading failure"))
      .mockResolvedValueOnce({ convert: () => "<p>converted</p>" });

    await expect(
      transformPostHtmlWithGukhanmun("<p>漢字</p>", "ko"),
    ).rejects.toThrow("temporary loading failure");
    await expect(
      transformPostHtmlWithGukhanmun("<p>漢字</p>", "ko"),
    ).resolves.toBe("<p>converted</p>");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
