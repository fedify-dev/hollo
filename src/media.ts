import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type { Sharp } from "sharp";
import { drive } from "./storage";

const logger = getLogger(["hollo", "media"]);
const DEFAULT_THUMBNAIL_AREA = 230_400;
const defaultScreenshot = readFileSync(
  join(import.meta.dirname, "..", "assets", "default-screenshot.png"),
);

export interface Thumbnail {
  thumbnailUrl: string;
  thumbnailType: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

export async function uploadThumbnail(
  id: string,
  original: Sharp,
  thumbnailArea = DEFAULT_THUMBNAIL_AREA,
): Promise<Thumbnail> {
  const disk = drive.use();
  const originalMetadata = await original.metadata();
  let width = originalMetadata.width!;
  let height = originalMetadata.height!;
  if (
    originalMetadata.orientation != null &&
    originalMetadata.orientation !== 1
  ) {
    original = original.clone();
    original.rotate();
    if (originalMetadata.orientation !== 3) {
      [width, height] = [height, width];
    }
  }
  const thumbnailSize = calculateThumbnailSize(width, height, thumbnailArea);
  const thumbnail = await original
    .resize(thumbnailSize)
    .webp({ nearLossless: true })
    .toBuffer();
  const content = new Uint8Array(thumbnail);
  try {
    await disk.put(`media/${id}/thumbnail.webp`, content, {
      contentType: "image/webp",
      contentLength: content.byteLength,
      visibility: "public",
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Failed to store thumbnail: ${error.message}`, error);
    }
    throw error;
  }
  return {
    thumbnailUrl: await disk.getUrl(`media/${id}/thumbnail.webp`),
    thumbnailType: "image/webp",
    thumbnailWidth: thumbnailSize.width,
    thumbnailHeight: thumbnailSize.height,
  };
}

export function calculateThumbnailSize(
  width: number,
  height: number,
  maxArea: number,
): { width: number; height: number } {
  const ratio = width / height;
  if (width * height <= maxArea) return { width, height };
  const newHeight = Math.sqrt(maxArea / ratio);
  const newWidth = ratio * newHeight;
  return { width: Math.round(newWidth), height: Math.round(newHeight) };
}

export async function makeVideoScreenshot(
  videoData: Uint8Array,
): Promise<Uint8Array> {
  const resultBuffer: Buffer = await new Promise((resolve, _) => {
    const process = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-vframes",
      "1",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
    const stdin = process.stdin;
    const stdout = process.stdout;
    const stderr = process.stderr;
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    if (!stdin || !stdout || !stderr) {
      logger.error(
        "Could not build pipes to ffmpeg, can't create a video screenshot",
      );
      logger.error("ffmpeg output: {stderr}", {
        stderr: Buffer.concat(stderrChunks).toString(),
      });
      resolve(defaultScreenshot);
    }
    stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });
    stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    process.on("close", (code) => {
      if (code !== 0) {
        logger.error("ffmpeg returned a bad error code {code}", { code });
        logger.error("ffmpeg output: {stderr}", {
          stderr: Buffer.concat(stderrChunks).toString(),
        });
        resolve(defaultScreenshot);
      }
      resolve(Buffer.concat(chunks));
    });
    process.on("error", (error) => {
      logger.error("Could not run ffmpeg: {error}", { error });
      logger.error("ffmpeg output: {stderr}", {
        stderr: Buffer.concat(stderrChunks).toString(),
      });
      resolve(defaultScreenshot);
    });
    stdin.on("error", (_) => {
      // probably a EPIPE because ffmpeg does not consume the whole file; swallow it here
    });

    stdin.write(videoData);
    stdin.end();
  });
  return resultBuffer;
}
