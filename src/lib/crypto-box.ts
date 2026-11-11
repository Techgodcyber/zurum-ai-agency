import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Small authenticated-encryption helper (AES-256-GCM) for secrets we must store
 * but should never keep in plaintext — e.g. a MERCHANT's payment provider key.
 * The key is derived from MASTER_KEY (sha256). Format: v1:<iv>:<tag>:<ciphertext>
 * (all base64). If MASTER_KEY is unset, encryption is unavailable and callers
 * must refuse to store the secret (see isEncryptionConfigured).
 */

const log = logger.child({ mod: "crypto-box" });

export function isEncryptionConfigured(): boolean {
  return Boolean(env.MASTER_KEY);
}

function keyBytes(): Buffer {
  return createHash("sha256").update(String(env.MASTER_KEY)).digest(); // 32 bytes
}

export function encryptSecret(plaintext: string): string | null {
  if (!env.MASTER_KEY) {
    log.warn("MASTER_KEY unset — cannot encrypt a secret");
    return null;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(box: string | null | undefined): string | null {
  if (!box || !env.MASTER_KEY) return null;
  try {
    const [v, ivB, tagB, ctB] = box.split(":");
    if (v !== "v1" || !ivB || !tagB || !ctB) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    log.error({ err: (err as Error).message }, "secret decrypt failed");
    return null;
  }
}
