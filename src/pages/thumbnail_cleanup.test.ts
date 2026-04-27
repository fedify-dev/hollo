import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { getLoginCookie } from "../../tests/helpers/web";
import { getMediaWithDeletableThumbnails } from "../entities/medium";
import thumbnailCleanup from "./thumbnail_cleanup";

vi.mock("../entities/medium", () => ({
  getMediaWithDeletableThumbnails: vi.fn(),
}));

const app = new Hono();
app.route("/thumbnail_cleanup", thumbnailCleanup);

type DeletableMedia = Awaited<
  ReturnType<typeof getMediaWithDeletableThumbnails>
>;

function createMediaItems(count: number): DeletableMedia {
  return Array.from({ length: count }, (_, index) => ({
    created: new Date(Date.UTC(2025, 0, index + 1)),
  })) as DeletableMedia;
}

describe.sequential("thumbnail cleanup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.mocked(getMediaWithDeletableThumbnails).mockReset();
  });

  it("preserves preview counts over 999 across the redirect", async () => {
    expect.assertions(5);

    vi.mocked(getMediaWithDeletableThumbnails).mockResolvedValue(
      createMediaItems(4980),
    );

    const formData = new FormData();
    formData.append("before", "2026-04-12");
    const cookie = await getLoginCookie();
    const response = await app.request("/thumbnail_cleanup/clean_preview", {
      method: "POST",
      body: formData,
      headers: {
        Cookie: cookie,
      },
    });

    expect(response.status).toBe(302);

    const location = response.headers.get("Location");
    expect(location).not.toBeNull();

    const url = new URL(location!, "http://localhost");
    expect(url.searchParams.get("fileCount")).toBe("4980");

    const previewResponse = await app.request(url.pathname + url.search, {
      headers: {
        Cookie: cookie,
      },
    });

    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.text()).toContain("Number of Items: 4,980");
  });
});
