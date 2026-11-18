import { access, constants, lstatSync } from "node:fs";
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
      if (!FS_STORAGE_PATH) {
        throw new Error("FS_STORAGE_PATH is required");
      }

      const storagePath = isAbsolute(FS_STORAGE_PATH)
        ? FS_STORAGE_PATH
        : // @ts-ignore: Don't know why, but TS can't find ImportMeta.dir on CI
          join(dirname(import.meta.dirname), FS_STORAGE_PATH);

      if (!lstatSync(storagePath).isDirectory()) {
        throw new Error(
          `FS_STORAGE_PATH must point to a directory: ${storagePath}`,
        );
      }

      access(
        storagePath,
        constants.F_OK | constants.R_OK | constants.W_OK,
        (err) => {
          if (err) {
            throw new Error(`${storagePath} must be readable and writable`);
          }
        },
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
      if (bucket == null) throw new Error("S3_BUCKET is required");
      if (region == null) throw new Error("S3_REGION is required");
      if (accessKeyId == null) throw new Error("AWS_ACCESS_KEY_ID is required");
      if (secretAccessKey == null) {
        throw new Error("AWS_SECRET_ACCESS_KEY is required");
      }

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
        if (EMOJI_IMPORT_FS_PATH == null) {
          throw new Error("EMOJI_IMPORT_FS_PATH is required");
        }
        return new FSDriver({
          location: EMOJI_IMPORT_FS_PATH,
          visibility: "private",
        });
      }
      if (EMOJI_IMPORT_DISK === "s3") {
        if (S3_EMOJI_IMPORT_BUCKET == null) {
          throw new Error("S3_EMOJI_IMPORT_BUCKET is required");
        }
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
