import { accessSync, constants, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

import { DriveManager } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";

import {
  DRIVE_DISK,
  EMOJI_IMPORT_DISK,
  EMOJI_IMPORT_FS_PATH,
  FS_STORAGE_PATH,
  S3_EMOJI_IMPORT_BUCKET,
  STORAGE_URL_BASE,
} from "./storage-config";

const require = createRequire(import.meta.url);

// oxlint-disable-next-line typescript/dot-notation
const region = process.env["S3_REGION"];

// oxlint-disable-next-line typescript/dot-notation
const bucket = process.env["S3_BUCKET"];

// oxlint-disable-next-line typescript/dot-notation
const endpointUrl = process.env["S3_ENDPOINT_URL"];

// oxlint-disable-next-line typescript/dot-notation
const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];

// oxlint-disable-next-line typescript/dot-notation
const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];

function validateFsStoragePath(
  storagePath: string | undefined,
  variableName: string,
): string {
  if (storagePath == null) {
    throw new Error(`${variableName} is required`);
  }

  const resolvedPath = isAbsolute(storagePath)
    ? storagePath
    : // @ts-ignore: Don't know why, but TS can't find ImportMeta.dir on CI
      join(dirname(import.meta.dirname), storagePath);

  if (!lstatSync(resolvedPath).isDirectory()) {
    throw new Error(
      `${variableName} must point to a directory: ${resolvedPath}`,
    );
  }

  try {
    accessSync(resolvedPath, constants.F_OK | constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`${resolvedPath} must be readable and writable`);
  }

  return resolvedPath;
}

function validateS3Configuration(
  bucketName: string | undefined,
  bucketVariableName: string,
): asserts bucketName is string {
  if (bucketName == null) throw new Error(`${bucketVariableName} is required`);
  if (region == null) throw new Error("S3_REGION is required");
  if (accessKeyId == null) throw new Error("AWS_ACCESS_KEY_ID is required");
  if (secretAccessKey == null) {
    throw new Error("AWS_SECRET_ACCESS_KEY is required");
  }
}

if (EMOJI_IMPORT_DISK === "fs") {
  validateFsStoragePath(EMOJI_IMPORT_FS_PATH, "EMOJI_IMPORT_FS_PATH");
} else if (EMOJI_IMPORT_DISK === "s3") {
  validateS3Configuration(S3_EMOJI_IMPORT_BUCKET, "S3_EMOJI_IMPORT_BUCKET");
}

export const drive = new DriveManager({
  /**
   * Name of the default service. It must be defined inside
   * the service object
   */
  default: DRIVE_DISK,

  fakes: {
    location: new URL("../tmp/fakes", import.meta.url),
    urlBuilder: {
      async generateURL(key) {
        return new URL(`/assets/${key}`, STORAGE_URL_BASE).href;
      },
      async generateSignedURL(key) {
        const url = new URL(`/assets/${key}`, STORAGE_URL_BASE);
        url.searchParams.set("signature", "true");

        return url.href;
      },
    },
  },

  /**
   * A collection of services you plan to use in your application
   */
  services: {
    fs: () => {
      const storagePath = validateFsStoragePath(
        FS_STORAGE_PATH,
        "FS_STORAGE_PATH",
      );

      return new FSDriver({
        location: storagePath,
        visibility: "public",
        urlBuilder: {
          async generateURL(key: string) {
            return new URL(`/assets/${key}`, STORAGE_URL_BASE).href;
          },
        },
      });
    },
    s3: () => {
      validateS3Configuration(bucket, "S3_BUCKET");

      const { fromEnv } =
        require("@aws-sdk/credential-providers") as typeof import("@aws-sdk/credential-providers");
      const { S3Driver } =
        require("flydrive/drivers/s3") as typeof import("flydrive/drivers/s3");

      return new S3Driver({
        credentials: fromEnv(),
        region,
        endpoint: endpointUrl,
        bucket,
        // oxlint-disable-next-line typescript/dot-notation
        forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] === "true",
        visibility: "public",
        cdnUrl: STORAGE_URL_BASE,
      });
    },
    emojiImports: () => {
      if (EMOJI_IMPORT_DISK === "fs") {
        const storagePath = validateFsStoragePath(
          EMOJI_IMPORT_FS_PATH,
          "EMOJI_IMPORT_FS_PATH",
        );
        return new FSDriver({
          location: storagePath,
          visibility: "private",
        });
      }
      if (EMOJI_IMPORT_DISK === "s3") {
        validateS3Configuration(
          S3_EMOJI_IMPORT_BUCKET,
          "S3_EMOJI_IMPORT_BUCKET",
        );
        const { fromEnv } =
          require("@aws-sdk/credential-providers") as typeof import("@aws-sdk/credential-providers");
        const { S3Driver } =
          require("flydrive/drivers/s3") as typeof import("flydrive/drivers/s3");
        return new S3Driver({
          credentials: fromEnv(),
          region,
          endpoint: endpointUrl,
          bucket: S3_EMOJI_IMPORT_BUCKET,
          forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] === "true",
          visibility: "private",
          supportsACL: false,
        });
      }

      throw new Error("Emoji ZIP import storage is not configured");
    },
  },
});
