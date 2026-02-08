import type { Context } from "@fedify/fedify";
import { Emoji, Image } from "@fedify/vocab";

interface CustomEmoji {
  shortcode: string;
  url: string;
}

export function toEmoji(ctx: Context<unknown>, emoji: CustomEmoji): Emoji {
  const shortcode = emoji.shortcode.replace(/^:|:$/g, "");
  return new Emoji({
    id: ctx.getObjectUri(Emoji, { shortcode }),
    name: `:${shortcode}:`,
    icon: new Image({ url: new URL(emoji.url) }),
  });
}
