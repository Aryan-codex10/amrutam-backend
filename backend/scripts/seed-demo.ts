import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import {
  demoTotpSecret,
  encrypt,
  hashPassword,
  lookupHash,
} from "../src/security.js";

if (
  (process.env.APP_ENV || "development") !== "development" ||
  process.argv[2] !== "--confirm"
)
  throw new Error("Run only in development with: npm run seed -- --confirm");
const pool = new Pool({
  connectionString: (
    process.env.DATABASE_URL ||
    "postgres://amrutam:amrutam_dev_only@localhost:5432/amrutam"
  ).replace("postgresql+psycopg://", "postgresql://"),
});
const ns = "24d9bc4f-fb1e-4f93-b077-7c152b5ecb4a";
function stable(name: string) {
  const h = createHash("sha1")
    .update(
      Buffer.concat([
        Buffer.from(ns.replaceAll("-", ""), "hex"),
        Buffer.from(name),
      ]),
    )
    .digest();
  h[6] = (h[6]! & 15) | 0x50;
  h[8] = (h[8]! & 63) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const doctors = [
  ["Aarav Mehta", "General Medicine"],
  ["Diya Shah", "Cardiology"],
  ["Kabir Rao", "Dermatology"],
  ["Mira Iyer", "Pediatrics"],
  ["Neel Kapoor", "Orthopedics"],
];
let added = 0,
  slots = 0;
try {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    async function user(email: string, role: string, password: string) {
      const hash = lookupHash(email);
      let r = (
        await c.query("SELECT id,role FROM users WHERE email_lookup_hash=$1", [
          hash,
        ])
      ).rows[0];
      if (r) {
        if (r.role !== role) throw Error(`Role mismatch: ${email}`);
        if (role !== "patient") {
          await c.query(
            "UPDATE users SET mfa_secret=$1,mfa_enabled=true WHERE id=$2 AND mfa_enabled=false",
            [encrypt(demoTotpSecret(email)), r.id],
          );
        }
        return r.id;
      }
      const id = stable(`user:${email}`);
      const pass = await hashPassword(password);
      await c.query(
        "INSERT INTO users(id,email,email_lookup_hash,password_hash,role,is_active,mfa_secret,mfa_enabled) VALUES($1,$2,$3,$4,$5,true,$6,$7)",
        [
          id,
          encrypt(email),
          hash,
          pass,
          role,
          role === "patient" ? null : encrypt(demoTotpSecret(email)),
          role !== "patient",
        ],
      );
      added++;
      return id;
    }
    const admin = await user(
      "admin.demo@example.com",
      "admin",
      "Demo-Admin-2026!",
    );
    void admin;
    const patient = await user(
      "patient01.demo@example.com",
      "patient",
      "Demo-Patient-2026!",
    );
    const patientIds = [patient];
    for (let i = 2; i <= 14; i++)
      patientIds.push(
        await user(
          `patient${String(i).padStart(2, "0")}.demo@example.com`,
          "patient",
          "Demo-Patient-2026!",
        ),
      );
    const docIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const email = `doctor${String(i).padStart(2, "0")}.demo@example.com`,
        uid = await user(email, "doctor", "Demo-Doctor-2026!"),
        [name, spec] = doctors[i - 1]!;
      let d = (await c.query("SELECT id FROM doctors WHERE user_id=$1", [uid]))
        .rows[0];
      if (!d) {
        const id = stable(`doctor:${i}`);
        await c.query(
          "INSERT INTO doctors(id,user_id,display_name,specialty,active) VALUES($1,$2,$3,$4,true)",
          [id, uid, name, spec],
        );
        d = { id };
      } else
        await c.query(
          "UPDATE doctors SET display_name=$1,specialty=$2,active=true WHERE id=$3",
          [name, spec, d.id],
        );
      docIds.push(d.id);
    }
    for (let i = 0; i < 5; i++) {
      const start = new Date(Date.now() + (4 + i) * 86400000);
      start.setUTCHours(10, 0, 0, 0);
      for (let j = 0; j < 2; j++) {
        const s = new Date(start.getTime() + (j === 0 ? 0 : 25 * 3600000)),
          e = new Date(s.getTime() + 30 * 60000);
        const id = stable(`slot:${i + 1}:${j + 1}`);
        const exists = await c.query(
          "SELECT id FROM availability_slots WHERE id=$1",
          [id],
        );
        if (exists.rowCount) {
          await c.query(
            "UPDATE availability_slots SET starts_at=$1,ends_at=$2 WHERE id=$3",
            [s, e, id],
          );
        } else {
          await c.query(
            "INSERT INTO availability_slots(id,doctor_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(doctor_id,starts_at) DO NOTHING",
            [id, docIds[i], s, e, "available"],
          );
          slots++;
        }
      }
    }
    const states = [
      "booked",
      "in_progress",
      "completed",
      "cancelled",
      "booked",
    ];
    for (let i = 0; i < states.length; i++) {
      const slotId = stable(`slot:${i + 1}:1`),
        id = stable(`consultation:${i + 1}`),
        key = `demo-seed-v1-${i + 1}`;
      const exists = await c.query(
        "SELECT id,status FROM consultations WHERE id=$1",
        [id],
      );
      if (!exists.rowCount) {
        await c.query(
          "INSERT INTO consultations(id,patient_id,doctor_id,slot_id,status,idempotency_key,reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            id,
            patientIds[i],
            docIds[i],
            slotId,
            states[i],
            key,
            encrypt("Synthetic demo visit; no real health information."),
          ],
        );
      }
      const current = exists.rows[0]?.status || states[i];
      await c.query("UPDATE availability_slots SET status=$1 WHERE id=$2", [
        current === "cancelled" ? "available" : "booked",
        slotId,
      ]);
      if (current === "in_progress" || current === "completed") {
        const pid = stable(`prescription:${i + 1}`);
        await c.query(
          "INSERT INTO prescriptions(id,consultation_id,doctor_id,body,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            pid,
            id,
            docIds[i],
            encrypt(
              "Synthetic demo prescription: sample instructions only; not medical advice.",
            ),
            new Date(),
          ],
        );
      }
    }
    await c.query("COMMIT");
    const totals = await pool.query(
      "SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM consultations) consultations,(SELECT count(*)::int FROM prescriptions) prescriptions",
    );
    console.log(
      JSON.stringify(
        {
          demo_users_total: 20,
          users_added_this_run: added,
          doctors: 5,
          slots_added_this_run: slots,
          consultations: 5,
          prescriptions: 2,
          users_in_database: totals.rows[0]?.users,
        },
        null,
        2,
      ),
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
