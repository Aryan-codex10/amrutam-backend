import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { encrypt, decrypt, lookupHash } from "../src/security.js";
if ((process.env.APP_ENV || "development") !== "development")
  throw new Error("This convenience migration is development-only");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL?.replace(
    "postgresql+psycopg://",
    "postgresql://",
  ),
});
async function cols(table: string) {
  return (
    await pool.query<{ column_name: string; data_type: string }>(
      "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
      [table],
    )
  ).rows;
}
async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const present = await c.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='users'",
    );
    if (!present.rowCount) {
      const schema = await readFile(
        new URL("../../../database/schema.sql", import.meta.url),
        "utf8",
      );
      await c.query(schema);
    }
    let users = await cols("users");
    if (!users.some((x) => x.column_name === "email_lookup_hash")) {
      await c.query("ALTER TABLE users ADD COLUMN email_ciphertext BYTEA");
      await c.query(
        "ALTER TABLE users ADD COLUMN email_lookup_hash VARCHAR(64)",
      );
      await c.query("ALTER TABLE users ADD COLUMN mfa_secret BYTEA");
      await c.query(
        "ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE",
      );
      await c.query("ALTER TABLE users ADD COLUMN mfa_last_counter BIGINT");
      for (const row of (await c.query("SELECT id,email FROM users")).rows) {
        const email = String(row.email || "")
          .trim()
          .toLowerCase();
        await c.query(
          "UPDATE users SET email_ciphertext=$1,email_lookup_hash=$2 WHERE id=$3",
          [encrypt(email), lookupHash(email), row.id],
        );
      }
      await c.query(
        "ALTER TABLE users ALTER COLUMN email_ciphertext SET NOT NULL",
      );
      await c.query(
        "ALTER TABLE users ALTER COLUMN email_lookup_hash SET NOT NULL",
      );
      await c.query("ALTER TABLE users DROP COLUMN email");
      await c.query(
        "ALTER TABLE users RENAME COLUMN email_ciphertext TO email",
      );
      await c.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_lookup_hash ON users(email_lookup_hash)",
      );
    }
    for (const [table, column, required] of [
      ["users", "email", true],
      ["users", "mfa_secret", false],
      ["profiles", "phone_ciphertext", false],
      ["profiles", "date_of_birth_ciphertext", false],
      ["consultations", "reason", true],
      ["prescriptions", "body", true],
    ] as const) {
      const meta = (await cols(table)).find((x) => x.column_name === column);
      if (!meta || meta.data_type === "bytea") continue;
      const temp = `${column}_ciphertext`;
      await c.query(`ALTER TABLE "${table}" ADD COLUMN "${temp}" BYTEA`);
      const idCol = table === "profiles" ? "user_id" : "id";
      for (const row of (
        await c.query(
          `SELECT "${idCol}" as id,"${column}" as value FROM "${table}"`,
        )
      ).rows) {
        if (row.value !== null)
          await c.query(
            `UPDATE "${table}" SET "${temp}"=$1 WHERE "${idCol}"=$2`,
            [encrypt(String(row.value)), row.id],
          );
      }
      if (required)
        await c.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${temp}" SET NOT NULL`,
        );
      await c.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
      await c.query(
        `ALTER TABLE "${table}" RENAME COLUMN "${temp}" TO "${column}"`,
      );
    }
    for (const row of (await c.query("SELECT id,email FROM users")).rows) {
      const clear = decrypt(row.email).trim().toLowerCase();
      await c.query("UPDATE users SET email_lookup_hash=$1 WHERE id=$2", [
        lookupHash(clear),
        row.id,
      ]);
    }
    await c.query(
      "ALTER TABLE prescriptions ALTER COLUMN created_at SET DEFAULT now()",
    );
    await c.query("COMMIT");
    console.log("Database encryption migration complete; data was preserved.");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
main();
