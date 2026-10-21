import { Pool } from "pg";
import { encrypt, hashPassword, lookupHash } from "../src/security.js";
import { randomUUID } from "node:crypto";
const email = process.env.ADMIN_EMAIL,
  password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12)
  throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars)");
if (
  process.env.APP_ENV === "production" &&
  process.env.ALLOW_ADMIN_BOOTSTRAP !== "true"
)
  throw new Error(
    "Production bootstrap requires explicit ALLOW_ADMIN_BOOTSTRAP=true",
  );
const pool = new Pool({
  connectionString: process.env.DATABASE_URL?.replace(
    "postgresql+psycopg://",
    "postgresql://",
  ),
});
try {
  const h = lookupHash(email);
  const exists = await pool.query(
    "SELECT id FROM users WHERE email_lookup_hash=$1",
    [h],
  );
  if (exists.rowCount) throw new Error("Account already exists");
  await pool.query(
    "INSERT INTO users(id,email,email_lookup_hash,password_hash,role) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), encrypt(email), h, await hashPassword(password), "admin"],
  );
  console.log(
    "Admin account created; enroll MFA at /docs before privileged APIs.",
  );
} finally {
  await pool.end();
}
