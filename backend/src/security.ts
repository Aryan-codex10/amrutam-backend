import crypto from "node:crypto";
import bcrypt from "bcrypt";

export const DEV_FERNET = crypto
  .createHash("sha256")
  .update("amrutam-local-demo-encryption-key-only")
  .digest("base64url");
const DEV_LOOKUP = "amrutam-local-demo-email-lookup-key-only";
const keyList = () =>
  (
    process.env.PHI_ENCRYPTION_KEYS ||
    (process.env.APP_ENV === "production" ? "" : DEV_FERNET)
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const b64 = (v: Buffer) => v.toString("base64url");
const unb64 = (v: string) => Buffer.from(v, "base64url");

export function validateEncryptionKeys() {
  const keys = keyList();
  if (
    !keys.length ||
    keys.some(
      (value) =>
        !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || unb64(value).length !== 32,
    )
  ) {
    throw new Error(
      "PHI_ENCRYPTION_KEYS must contain one or more URL-safe 32-byte Fernet keys",
    );
  }
}

// Fernet-compatible token format keeps existing PostgreSQL BYTEA ciphertext readable.
export function encrypt(value: string): Buffer {
  const key = unb64(keyList()[0] || "");
  if (key.length !== 32)
    throw new Error("PHI_ENCRYPTION_KEYS must contain URL-safe Fernet keys");
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key.subarray(16), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const signed = Buffer.concat([Buffer.from([0x80]), ts, iv, ct]);
  const mac = crypto
    .createHmac("sha256", key.subarray(0, 16))
    .update(signed)
    .digest();
  const encoded = b64(Buffer.concat([signed, mac]));
  return Buffer.from(
    encoded + "=".repeat((4 - (encoded.length % 4)) % 4),
    "ascii",
  );
}
export function decrypt(token: Buffer | string): string {
  const raw = unb64(Buffer.isBuffer(token) ? token.toString("ascii") : token);
  for (const encoded of keyList()) {
    const key = unb64(encoded);
    if (key.length !== 32 || raw.length < 57 || raw[0] !== 0x80) continue;
    const data = raw.subarray(0, -32),
      mac = raw.subarray(-32);
    const expected = crypto
      .createHmac("sha256", key.subarray(0, 16))
      .update(data)
      .digest();
    if (!crypto.timingSafeEqual(mac, expected)) continue;
    try {
      const d = crypto.createDecipheriv(
        "aes-128-cbc",
        key.subarray(16),
        raw.subarray(9, 25),
      );
      return Buffer.concat([
        d.update(raw.subarray(25, -32)),
        d.final(),
      ]).toString("utf8");
    } catch {
      /* try previous rotation key */
    }
  }
  throw new Error("Cannot decrypt encrypted field; verify PHI_ENCRYPTION_KEYS");
}
export function lookupHash(email: string) {
  return crypto
    .createHmac("sha256", process.env.EMAIL_LOOKUP_KEY || DEV_LOOKUP)
    .update(email.trim().toLowerCase())
    .digest("hex");
}
export function newTotpSecret() {
  return base32(crypto.randomBytes(20));
}
export function demoTotpSecret(email: string) {
  return base32(
    crypto
      .createHash("sha256")
      .update(`amrutam-demo-totp:${email.trim().toLowerCase()}`)
      .digest(),
  ).slice(0, 52);
}
function base32(buf: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function from32(text: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0,
    out: number[] = [];
  for (const c of text.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw Error("Invalid base32");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totpCounter(secret: string, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", from32(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
export function verifyTotp(secret: string, code: string) {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const c of [now - 1, now, now + 1])
    if (totpCounter(secret, c) === code) return c;
  return null;
}
export const hashPassword = (p: string) => bcrypt.hash(p, 12);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);
