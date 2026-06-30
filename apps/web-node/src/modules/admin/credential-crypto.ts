import { createCipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";

const KEY_VERSION = "local-master-key-v1";
const AES_ALGORITHM = "aes-256-gcm";
const masterKey = Buffer.from(env.CREDENTIAL_MASTER_KEY_BASE64, "base64");

if (masterKey.length !== 32) {
  throw new Error("CREDENTIAL_MASTER_KEY_BASE64 must decode to 32 bytes.");
}

interface EnvelopePayload {
  iv: string;
  tag: string;
  value: string;
}

export interface EncryptedCredentialEnvelope {
  encryptedPayload: string;
  encryptedDataKey: string;
  keyVersion: string;
}

export function encryptCredentialPayload(payload: Record<string, unknown>): EncryptedCredentialEnvelope {
  const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
  const dataKey = randomBytes(32);
  const encryptedPayload = seal(payloadBuffer, dataKey);
  const encryptedDataKey = seal(dataKey, masterKey);

  return {
    encryptedPayload,
    encryptedDataKey,
    keyVersion: KEY_VERSION
  };
}

export function maskCredentialPayload(payload: Record<string, unknown>): string | null {
  const candidate = extractMaskableValue(payload);
  if (!candidate) return null;

  const normalized = candidate.replace(/\s+/g, "");
  if (normalized.length <= 8) return normalized;
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`.slice(0, 40);
}

function extractMaskableValue(payload: Record<string, unknown>): string | null {
  const directKeys = ["api_key", "apiKey", "token", "access_token", "secret", "client_secret"];
  for (const key of directKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const flatString = Object.values(payload).find((value) => typeof value === "string" && value.trim());
  return typeof flatString === "string" ? flatString.trim() : null;
}

function seal(value: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EnvelopePayload = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    value: encrypted.toString("base64")
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

