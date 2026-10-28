import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
const SALTLEN = 16;

export function hashSecret(secret: string): string {
  const salt = randomBytes(SALTLEN);
  const hash = scryptSync(secret, salt, KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  if (typeof secret !== "string" || typeof stored !== "string" || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    hash = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  const computed = scryptSync(secret, salt, KEYLEN);
  if (computed.length !== hash.length) return false;
  return timingSafeEqual(computed, hash);
}

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function generateVaultId(): string {
  return randomBytes(8).toString("hex");
}
