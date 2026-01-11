import { base64 } from "@hexagon/base64";
import type { HonoRequest } from "hono";
import type z from "zod";

export async function requestBody<T extends z.ZodType = z.ZodTypeAny>(
  req: HonoRequest,
  schema: T,
  // biome-ignore lint/suspicious/noExplicitAny: Input type is `any` as it comes from the request
): Promise<z.ZodSafeParseSuccess<z.output<T>> | z.ZodSafeParseError<any>> {
  const contentType = req.header("Content-Type")?.toLowerCase();
  if (
    contentType === "application/json" ||
    contentType?.startsWith("application/json")
  ) {
    const json = await req.json();
    return await schema.safeParseAsync(json);
  }

  // Some clients (like Lobsters' Sponge) don't set Content-Type header for
  // POST requests with form data. In this case, Hono's parseBody() returns
  // an empty object because it defaults to text/plain.
  // We need to manually parse the body as URL-encoded form data.
  if (
    contentType === undefined ||
    contentType === "text/plain" ||
    contentType.startsWith("text/plain;")
  ) {
    const text = await req.text();
    if (text?.includes("=")) {
      const params = new URLSearchParams(text);
      const parsed: Record<string, string> = {};
      for (const [key, value] of params) {
        parsed[key] = value;
      }
      return await schema.safeParseAsync(parsed);
    }
  }

  const formData = await req.parseBody();
  return await schema.safeParseAsync(formData);
}

// URL safe in ABNF is: ALPHA / DIGIT / "-" / "." / "_" / "~"
export const URL_SAFE_REGEXP = /[A-Za-z0-9_\-.~]/;

export function base64Url(buffer: ArrayBuffer) {
  return base64.fromArrayBuffer(buffer, true);
}

export function randomBytes(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)).buffer);
}
