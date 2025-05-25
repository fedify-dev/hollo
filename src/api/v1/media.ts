import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import mime from "mime";
import sharp from "sharp";
import { db } from "../../db";
import { serializeMedium } from "../../entities/medium";
import { makeVideoScreenshot, uploadThumbnail } from "../../media";
import { type Variables, scopeRequired, tokenRequired } from "../../oauth";
import { media } from "../../schema";
import { disk, getAssetUrl } from "../../storage";
import { isUuid, uuidv7 } from "../../uuid";

const app = new Hono<{ Variables: Variables }>();

export async function postMedia(c: Context<{ Variables: Variables }>) {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "file is required" }, 422);
  }
  const description = form.get("description")?.toString();
  const id = uuidv7();
  const imageData = new Uint8Array(await file.arrayBuffer());
  let imageBytes: Uint8Array = imageData;
  if (file.type.startsWith("video/")) {
    imageBytes = await makeVideoScreenshot(imageData);
  }

  const image = sharp(imageBytes).rotate();
  const rmMetaImage = await image.keepIccProfile().toBuffer();
  const fileMetadata = await sharp(rmMetaImage).metadata();
  const content = file.type.startsWith("video/")
    ? new Uint8Array(imageData)
    : new Uint8Array(rmMetaImage);

  const extension = mime.getExtension(file.type);
  if (!extension) {
    return c.json({ error: "Unsupported media type" }, 400);
  }
  const sanitizedExt = extension.replace(/[/\\]/g, "");
  const path = `media/${id}/original.${sanitizedExt}`;
  try {
    await disk.put(path, content, {
      contentType: file.type,
      contentLength: content.byteLength,
      visibility: "public",
    });
  } catch (error) {
    return c.json({ error: "Failed to save media file" }, 500);
  }
  const url = getAssetUrl(path, c.req.url);
  const result = await db
    .insert(media)
    .values({
      id,
      type: file.type,
      url,
      width: fileMetadata.width!,
      height: fileMetadata.height!,
      description,
      ...(await uploadThumbnail(id, image, c.req.url)),
    })
    .returning();
  if (result.length < 1) {
    return c.json({ error: "Failed to insert media" }, 500);
  }
  return c.json(serializeMedium(result[0]));
}

app.post("/", tokenRequired, scopeRequired(["write:media"]), postMedia);

app.get("/:id", async (c) => {
  const mediumId = c.req.param("id");
  if (!isUuid(mediumId)) return c.json({ error: "Not found" }, 404);
  const medium = await db.query.media.findFirst({
    where: eq(media.id, mediumId),
  });
  if (medium == null) return c.json({ error: "Not found" }, 404);
  return c.json(serializeMedium(medium));
});

app.put("/:id", tokenRequired, scopeRequired(["write:media"]), async (c) => {
  const mediumId = c.req.param("id");
  if (!isUuid(mediumId)) return c.json({ error: "Not found" }, 404);
  let description: string | undefined;
  try {
    const json = await c.req.json();
    description = json.description;
  } catch (e) {
    const form = await c.req.formData();
    description = form.get("description")?.toString();
  }
  if (description == null) {
    return c.json({ error: "description is required" }, 422);
  }
  const result = await db
    .update(media)
    .set({ description })
    .where(eq(media.id, mediumId))
    .returning();
  if (result.length < 1) return c.json({ error: "Not found" }, 404);
  return c.json(serializeMedium(result[0]));
});

export default app;
