import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decrypt,
  demoTotpSecret,
  encrypt,
  lookupHash,
  totpCounter,
  verifyTotp,
} from "../src/security.js";
test("encrypted field round-trips using Fernet-compatible tokens", () => {
  const token = encrypt("private clinical note");
  assert.equal(decrypt(token), "private clinical note");
  assert.equal(token[0], "g".charCodeAt(0));
});
test("lookup digest normalizes email and demo TOTP matches current counter", () => {
  assert.equal(
    lookupHash(" PATIENT@EXAMPLE.COM "),
    lookupHash("patient@example.com"),
  );
  const secret = demoTotpSecret("doctor01.demo@example.com"),
    counter = Math.floor(Date.now() / 30000),
    code = totpCounter(secret, counter);
  assert.equal(verifyTotp(secret, code), counter);
});
