import { access, constants, lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fromEnv } from "@aws-sdk/credential-providers";
import { getLogger } from "@logtape/logtape";
import { DriveManager } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";
import { S3Driver } from "flydrive/drivers/s3";

const logger = getLogger(["hollo", "storage"]);

export type DriveDisk = "fs" | "s3";

if (
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["FS_ASSET_PATH"] !== undefined &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["FS_STORAGE_PATH"] === undefined
) {
  logger.warn("FS_ASSET_PATH is deprecated; use FS_STORAGE_PATH instead.");
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["FS_STORAGE_PATH"] = process.env["FS_ASSET_PATH"];
}

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
export const FS_STORAGE_PATH = process.env["FS_STORAGE_PATH"];

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const region = process.env["S3_REGION"];

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const bucket = process.env["S3_BUCKET"];

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const endpointUrl = process.env["S3_ENDPOINT_URL"];

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];

let driveDisk: DriveDisk;

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const driveDiskEnv = process.env["DRIVE_DISK"];
if (driveDiskEnv === undefined) {
  logger.warn(
    "DRIVE_DISK is not configured; defaults to 's3'.  " +
      "The DRIVE_DISK environment variable will be mandatory in the future versions.",
  );
  driveDisk = "s3";
} else if (driveDiskEnv.toLowerCase() === "s3") {
  driveDisk = "s3";
} else if (driveDiskEnv.toLowerCase() === "fs") {
  driveDisk = "fs";
} else {
  throw new Error(`Unknown DRIVE_DISK value: '${driveDiskEnv}'`);
}

export const DRIVE_DISK: DriveDisk = driveDisk;

if (
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["ASSET_URL_BASE"] !== undefined &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] === undefined
) {
  logger.warn("ASSET_URL_BASE is deprecated; use STORAGE_URL_BASE instead.");
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] = process.env["ASSET_URL_BASE"];
}

if (
  driveDisk === "s3" &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["S3_URL_BASE"] !== undefined &&
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] === undefined
) {
  logger.warn("S3_URL_BASE is deprecated; use STORAGE_URL_BASE instead.");
  // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
  process.env["STORAGE_URL_BASE"] = process.env["S3_URL_BASE"];
}

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const storageUrlBase = process.env["STORAGE_URL_BASE"];

if (!storageUrlBase) {
  throw new Error("STORAGE_URL_BASE is required");
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
        return new URL(`/assets/${key}`, storageUrlBase).href;
      },
      async generateSignedURL(key) {
        const url = new URL(`/assets/${key}`, storageUrlBase);
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
            return new URL(`/assets/${key}`, storageUrlBase).href;
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

      return new S3Driver({
        credentials: fromEnv(),
        region,
        endpoint: endpointUrl,
        bucket,
        // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
        forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] === "true",
        visibility: "public",
        cdnUrl: storageUrlBase,
      });
    },
  },
});
