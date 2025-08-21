import { base64 } from "@hexagon/base64";
import type { HonoRequest } from "hono";
import type z from "zod";

export async function requestBody<T extends z.ZodType = z.ZodTypeAny>(
  req: HonoRequest,
  schema: T,
  // biome-ignore lint/suspicious/noExplicitAny: Input type is `any` as it comes from the request
): Promise<z.SafeParseReturnType<any, z.output<T>>> {
  const contentType = req.header("Content-Type")?.toLowerCase();
  if (
    contentType === "application/json" ||
    contentType?.startsWith("application/json")
  ) {
    const json = await req.json();
    return await schema.safeParseAsync(json);
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
