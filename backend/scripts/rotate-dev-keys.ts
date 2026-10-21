import { Pool } from "pg";
import { decrypt, DEV_FERNET, encrypt, lookupHash } from "../src/security.js";
if ((process.env.APP_ENV || "development") !== "development")
  throw new Error("Key rotation helper is development-only");
const keys = (process.env.PHI_ENCRYPTION_KEYS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
if (keys.length < 2)
  throw new Error("Set PHI_ENCRYPTION_KEYS=NEW_KEY,OLD_KEY before rotation");
if (!keys.includes(DEV_FERNET)) {
  keys.push(DEV_FERNET);
  process.env.PHI_ENCRYPTION_KEYS = keys.join(",");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL?.replace(
    "postgresql+psycopg://",
    "postgresql://",
  ),
});
try {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const [table, column] of [
      ["users", "email"],
      ["users", "mfa_secret"],
      ["profiles", "phone_ciphertext"],
      ["profiles", "date_of_birth_ciphertext"],
      ["consultations", "reason"],
      ["prescriptions", "body"],
    ]) {
      const idcol = table === "profiles" ? "user_id" : "id";
      const rows = await c.query(
        `SELECT "${idcol}" id,"${column}" value FROM "${table}" WHERE "${column}" IS NOT NULL`,
      );
      for (const row of rows.rows) {
        const plain = decrypt(row.value);
        await c.query(
          `UPDATE "${table}" SET "${column}"=$1 WHERE "${idcol}"=$2`,
          [encrypt(plain), row.id],
        );
      }
    }
    for (const row of (await c.query("SELECT id,email FROM users")).rows)
      await c.query("UPDATE users SET email_lookup_hash=$1 WHERE id=$2", [
        lookupHash(decrypt(row.email)),
        row.id,
      ]);
    await c.query("COMMIT");
    console.log(
      "Local key rotation complete. Keep the previous key until all backups and copies are rotated.",
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
} finally {
  await pool.end();
}
