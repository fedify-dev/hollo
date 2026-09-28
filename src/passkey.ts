import { Buffer } from "node:buffer";

import type {
  AuthenticationResponseJSON,
  Base64URLString,
  CredentialDeviceType,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

import type { Passkey } from "./schema";

export const RP_NAME = "Hollo";

export interface RpInfo {
  rpID: string;
  origin: string;
}

/** Derive WebAuthn relying-party info from an incoming request URL. */
export function getRpInfo(requestUrl: string | URL): RpInfo {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

/** Derive a stable, opaque WebAuthn user handle from the credential email. */
export async function userIdFromEmail(
  email: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const data = new TextEncoder().encode(email.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

export interface BuildRegistrationOptionsInput {
  rpInfo: RpInfo;
  email: string;
  existingCredentials: ReadonlyArray<{
    id: Base64URLString;
    transports?: ReadonlyArray<string>;
  }>;
}

export interface BuildRegistrationOptionsResult {
  options: PublicKeyCredentialCreationOptionsJSON;
  challenge: Base64URLString;
}

export async function buildRegistrationOptions(
  input: BuildRegistrationOptionsInput,
): Promise<BuildRegistrationOptionsResult> {
  const userID = await userIdFromEmail(input.email);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: input.rpInfo.rpID,
    userName: input.email,
    userDisplayName: input.email,
    userID,
    attestationType: "none",
    excludeCredentials: input.existingCredentials.map((c) => ({
      id: c.id,
      transports: c.transports == null ? undefined : [...c.transports],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  return { options, challenge: options.challenge };
}

export interface VerifyRegistrationInput {
  rpInfo: RpInfo;
  response: RegistrationResponseJSON;
  expectedChallenge: Base64URLString;
}

export interface VerifiedRegistration {
  credentialId: Base64URLString;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: CredentialDeviceType;
  backedUp: boolean;
}

// The set of transport hint values WebAuthn defines.  Anything else the
// browser passes through gets dropped before we store it, so a malicious
// or buggy client can't poison future `excludeCredentials` payloads.
// SimpleWebAuthn v14 types these hints as plain `string[]`, so we keep our
// own allowlist (including the legacy "cable" alias for "hybrid" and the
// newer "smart-card") to decide what is safe to persist.
const VALID_TRANSPORTS: ReadonlySet<string> = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export function sanitizeTransports(
  values: readonly string[] | undefined,
): string[] {
  if (values == null) return [];
  const out: string[] = [];
  for (const v of values) {
    if (VALID_TRANSPORTS.has(v)) out.push(v);
  }
  return out;
}

export async function verifyRegistration(
  input: VerifyRegistrationInput,
): Promise<VerifiedRegistration | null> {
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.rpInfo.origin,
      expectedRPID: input.rpInfo.rpID,
      requireUserVerification: true,
    });
  } catch {
    // SimpleWebAuthn throws on malformed responses, origin / rpID
    // mismatches, unsupported attestation, etc.  Surface every failure
    // mode uniformly so callers can return a plain 400.
    return null;
  }
  if (!verification.verified || verification.registrationInfo == null) {
    return null;
  }
  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: sanitizeTransports(input.response.response.transports),
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

export interface BuildAuthenticationOptionsInput {
  rpInfo: RpInfo;
  allowedCredentials?: ReadonlyArray<{
    id: Base64URLString;
    transports?: ReadonlyArray<string>;
  }>;
}

export interface BuildAuthenticationOptionsResult {
  options: PublicKeyCredentialRequestOptionsJSON;
  challenge: Base64URLString;
}

export async function buildAuthenticationOptions(
  input: BuildAuthenticationOptionsInput,
): Promise<BuildAuthenticationOptionsResult> {
  const options = await generateAuthenticationOptions({
    rpID: input.rpInfo.rpID,
    allowCredentials:
      input.allowedCredentials == null
        ? undefined
        : input.allowedCredentials.map((c) => ({
            id: c.id,
            transports: c.transports == null ? undefined : [...c.transports],
          })),
    userVerification: "required",
  });
  return { options, challenge: options.challenge };
}

export interface VerifyAuthenticationInput {
  rpInfo: RpInfo;
  response: AuthenticationResponseJSON;
  expectedChallenge: Base64URLString;
  storedPasskey: Pick<Passkey, "id" | "publicKey" | "counter" | "transports">;
}

export interface VerifiedAuthentication {
  newCounter: number;
}

export async function verifyAuthentication(
  input: VerifyAuthenticationInput,
): Promise<VerifiedAuthentication | null> {
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.rpInfo.origin,
      expectedRPID: input.rpInfo.rpID,
      requireUserVerification: true,
      credential: {
        id: input.storedPasskey.id,
        publicKey: decodePublicKey(input.storedPasskey.publicKey),
        counter: input.storedPasskey.counter,
        transports: input.storedPasskey.transports,
      },
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  return { newCounter: verification.authenticationInfo.newCounter };
}

/** Encode a binary public-key blob for storage in a text column. */
export function encodePublicKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode a base64url-encoded public-key blob back into bytes. */
export function decodePublicKey(encoded: string): Uint8Array<ArrayBuffer> {
  return Buffer.from(encoded, "base64url");
}

const PLATFORM_LABELS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // Order matters: iOS / iPadOS strings include "Mac OS X", so they go first.
  { pattern: /\biPhone\b|\biPad\b|\biPod\b/, label: "iOS device" },
  { pattern: /\bAndroid\b/, label: "Android device" },
  { pattern: /\bMac OS X\b|\bMacintosh\b/, label: "macOS device" },
  { pattern: /\bWindows\b/, label: "Windows device" },
  { pattern: /\bLinux\b|\bX11\b/, label: "Linux device" },
];

/** Best-effort friendly device label derived from a User-Agent string. */
export function nicknameFromUserAgent(
  userAgent: string | null | undefined,
): string {
  if (userAgent == null) return "Passkey";
  const trimmed = userAgent.trim();
  if (trimmed === "") return "Passkey";
  for (const { pattern, label } of PLATFORM_LABELS) {
    if (pattern.test(trimmed)) return label;
  }
  return "Passkey";
}
