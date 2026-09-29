import { beforeEach, describe, expect, it } from "vitest";

import { getFixtureFile } from "../../tests/helpers";
import { getLoginCookie } from "../../tests/helpers/web";
import db from "../db";
import { customEmojis } from "../schema";
import { drive } from "../storage";
import app from "./index";

const emojiFile = await getFixtureFile("emoji.png", "image/png");

describe("emojis", { concurrent: false }, () => {
  beforeEach(async () => {
    await db.delete(customEmojis);

    return () => {
      drive.restore();
    };
  });

  it("Successfully saves a new emoji", async () => {
    expect.assertions(4);

    const disk = drive.fake();
    const testShortCode = ":test-emoji:";

    const formData = new FormData();
    formData.append("shortcode", testShortCode);
    formData.append("image", emojiFile);

    const cookie = await getLoginCookie();

    const response = await app.request("/emojis", {
      method: "POST",
      body: formData,
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/emojis");

    // Assert we uploaded the file:
    expect(() => disk.assertExists("emojis/test-emoji.png")).not.toThrowError();

    const emoji = await db.query.customEmojis.findFirst();

    expect(emoji).toMatchObject({
      category: null,
      url: "http://hollo.test/assets/emojis/test-emoji.png",
      shortcode: "test-emoji",
    });
  });
});
