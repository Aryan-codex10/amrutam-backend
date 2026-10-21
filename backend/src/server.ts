import Fastify, { FastifyRequest, LogController } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Pool, PoolClient } from "pg";
import { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkPassword,
  decrypt,
  encrypt,
  hashPassword,
  lookupHash,
  newTotpSecret,
  validateEncryptionKeys,
  verifyTotp,
} from "./security.js";

type Role = "patient" | "doctor" | "admin";
type User = {
  id: string;
  role: Role;
  email: Buffer;
  mfa_enabled: boolean;
  mfa_secret: Buffer | null;
  mfa_last_counter: string | null;
  is_active: boolean;
};
declare module "fastify" {
  interface FastifyRequest {
    actor?: User;
  }
}
const env = process.env;
const production = env.APP_ENV === "production";
if (
  production &&
  (!env.JWT_SECRET ||
    env.JWT_SECRET.length < 32 ||
    env.JWT_SECRET === "replace-with-32-byte-random-secret-before-deploy" ||
    !env.PHI_ENCRYPTION_KEYS ||
    !env.EMAIL_LOOKUP_KEY ||
    env.EMAIL_LOOKUP_KEY.length < 32)
)
  throw new Error(
    "Production must configure non-placeholder JWT_SECRET, PHI_ENCRYPTION_KEYS, and EMAIL_LOOKUP_KEY",
  );
if (production) validateEncryptionKeys();
const dbUrl = (
  env.NODE_ENV === "test"
    ? env.TEST_DATABASE_URL
    : env.DATABASE_URL ||
      "postgres://amrutam:amrutam_dev_only@localhost:5432/amrutam"
)?.replace("postgresql+psycopg://", "postgresql://");
const pool = new Pool({ connectionString: dbUrl, max: 10 });
const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 })
  : null;
export const app = Fastify({
  logController: new LogController({ disableRequestLogging: true }),
  logger: {
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
});
export { pool };
await app.register(cors, {
  origin: (env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((x) => x.trim()),
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "Idempotency-Key",
    "X-Request-ID",
  ],
});
await app.register(swagger, {
  openapi: {
    info: {
      title: "Amrutam Telemedicine API",
      version: "1.0.0",
      description: "Secure telemedicine workflow API",
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  },
});
await app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { url: "/openapi.yaml" },
});
app.get("/openapi.json", async () => app.swagger());
const contractPath = [
  resolve(process.cwd(), "api/openapi.yaml"),
  resolve(process.cwd(), "../api/openapi.yaml"),
].find(existsSync);
app.get("/openapi.yaml", async (_request, reply) => {
  if (!contractPath) error(500, "OpenAPI contract file is missing");
  reply.type("application/yaml; charset=utf-8");
  return readFile(contractPath);
});
const metrics = new Map<string, { count: number; sum: number }>();
const localHits = new Map<string, { n: number; until: number }>();
const q = async <T extends import("pg").QueryResultRow = any>(
  sql: string,
  values: any[] = [],
  client: Pool | PoolClient = pool,
) => (await client.query<T>(sql, values)).rows;
function audit(
  c: PoolClient,
  actor: string | null,
  action: string,
  type: string,
  id: string | null,
  rid: string,
) {
  return c.query(
    "INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,request_id,outcome) VALUES($1,$2,$3,$4,$5,$6)",
    [actor, action, type, id, rid, "success"],
  );
}
function error(status: number, message: string): never {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = status;
  throw e;
}
async function auth(req: FastifyRequest, roles?: Role[]) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) error(401, "Authentication required");
  let sub: string;
  try {
    sub = (
      jwt.verify(
        h.slice(7),
        env.JWT_SECRET || "local-only-change-me-32-bytes-minimum!!",
        { issuer: env.JWT_ISSUER || "amrutam-api", algorithms: ["HS256"] },
      ) as jwt.JwtPayload
    ).sub!;
  } catch {
    error(401, "Invalid or expired token");
  }
  const u = (
    await q<User>(
      "SELECT id,role,email,mfa_enabled,mfa_secret,mfa_last_counter,is_active FROM users WHERE id=$1",
      [sub],
    )
  )[0];
  if (!u || !u.is_active) error(401, "Account unavailable");
  if (roles && !roles.includes(u.role)) error(403, "Insufficient role");
  if (u.role !== "patient" && !u.mfa_enabled)
    error(403, "MFA enrollment required");
  req.actor = u;
  return u;
}
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.addHook("onRequest", async (req, reply) => {
  req.id = (req.headers["x-request-id"] as string) || randomUUID();
  reply.header("X-Request-ID", String(req.id));
  const path = req.url.split("?")[0]!;
  if (
    [
      "/api/v1/auth/login",
      "/api/v1/auth/register",
      "/api/v1/auth/mfa/setup",
      "/api/v1/auth/mfa/verify",
    ].includes(path)
  ) {
    const ip = req.ip;
    let n = 0;
    if (redis) {
      try {
        const key = `auth-rate:${ip}:${path}:${Math.floor(Date.now() / 60000)}`;
        n = await redis.incr(key);
        if (n === 1) await redis.expire(key, 120);
      } catch {
        redis.disconnect();
      }
    }
    if (!redis || redis.status === "end") {
      if (localHits.size > 5000) {
        for (const [key, value] of localHits)
          if (value.until <= Date.now()) localHits.delete(key);
      }
      const k = `${ip}:${path}`,
        v = localHits.get(k);
      n = v && v.until > Date.now() ? v.n + 1 : 1;
      localHits.set(k, { n, until: Date.now() + 60000 });
    }
    if (n > (path.endsWith("/verify") ? 5 : 20)) {
      reply
        .header("Retry-After", "60")
        .code(429)
        .send({ detail: "Too many authentication attempts" });
    }
  }
});
app.addHook("onResponse", async (req, reply) => {
  const route = req.routeOptions.url || "/unmatched";
  const metricRoute = route.startsWith("/health") ? route : "/api/*";
  const key = `${req.method}|${metricRoute}|${reply.statusCode}`;
  const m = metrics.get(key) || { count: 0, sum: 0 };
  m.count++;
  m.sum += reply.elapsedTime / 1000;
  metrics.set(key, m);
  req.log.info(
    {
      event: "http_request",
      request_id: req.id,
      method: req.method,
      route,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime * 100) / 100,
    },
    "request completed",
  );
});
app.get("/health/live", async () => ({ status: "alive" }));
app.get("/health/ready", async (_r, reply) => {
  try {
    await pool.query("SELECT 1");
    return { status: "ready" };
  } catch {
    reply.code(503);
    return { detail: "Database unavailable" };
  }
});
app.get("/metrics", async (_r, reply) => {
  let s =
    "# HELP http_requests_total HTTP requests\n# TYPE http_requests_total counter\n";
  for (const [k, m] of metrics) {
    const [method, path, status] = k.split("|");
    s += `http_requests_total{method="${method}",path="${path}",status="${status}"} ${m.count}\nhttp_request_duration_seconds_sum{method="${method}",path="${path}"} ${m.sum}\nhttp_request_duration_seconds_count{method="${method}",path="${path}"} ${m.count}\n`;
  }
  reply.type("text/plain; version=0.0.4; charset=utf-8").send(s);
});
app.post<{ Body: { email: string; password: string; role?: string } }>(
  "/api/v1/auth/register",
  async (req, reply) => {
    const { email, password, role = "patient" } = req.body || {};
    if (
      !emailRe.test(email || "") ||
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 72
    )
      error(422, "Valid email and password (12–72 characters) required");
    if (role !== "patient") error(403, "Self-registration is patient-only");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const hash = lookupHash(email);
      if (
        (await q("SELECT 1 FROM users WHERE email_lookup_hash=$1", [hash], c))
          .length
      )
        error(409, "Account already exists");
      const id = randomUUID();
      await c.query(
        "INSERT INTO users(id,email,email_lookup_hash,password_hash,role,is_active) VALUES($1,$2,$3,$4,$5,true)",
        [
          id,
          encrypt(email.trim().toLowerCase()),
          hash,
          await hashPassword(password),
          "patient",
        ],
      );
      await audit(c, id, "user.register", "user", id, String(req.id));
      await c.query("COMMIT");
      reply.code(201);
      return { id, email: email.toLowerCase(), role: "patient" };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
);
app.post<{ Body: { email: string; password: string; totp_code?: string } }>(
  "/api/v1/auth/login",
  async (req) => {
    const { email, password, totp_code } = req.body || {};
    if (!emailRe.test(email || "") || typeof password !== "string")
      error(422, "Email and password required");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const u = (
        await q<User & { password_hash: string }>(
          "SELECT id,email,password_hash,role,mfa_enabled,mfa_secret,mfa_last_counter,is_active FROM users WHERE email_lookup_hash=$1 FOR UPDATE",
          [lookupHash(email)],
          c,
        )
      )[0];
      if (!u || !(await checkPassword(password, u.password_hash)))
        error(401, "Invalid credentials");
      if (u.role !== "patient" && u.mfa_enabled) {
        if (!totp_code || !u.mfa_secret)
          error(401, "Authenticator code required");
        const ctr = verifyTotp(decrypt(u.mfa_secret), totp_code);
        if (
          ctr === null ||
          (u.mfa_last_counter !== null && ctr <= Number(u.mfa_last_counter))
        )
          error(401, "Invalid, expired, or reused authenticator code");
        await c.query("UPDATE users SET mfa_last_counter=$1 WHERE id=$2", [
          ctr,
          u.id,
        ]);
      }
      await c.query("COMMIT");
      const token = jwt.sign(
        { role: u.role },
        env.JWT_SECRET || "local-only-change-me-32-bytes-minimum!!",
        {
          subject: u.id,
          issuer: env.JWT_ISSUER || "amrutam-api",
          expiresIn: `${Number(env.ACCESS_TOKEN_MINUTES || 15)}m`,
          algorithm: "HS256",
        },
      );
      return {
        access_token: token,
        token_type: "bearer",
        expires_in: Number(env.ACCESS_TOKEN_MINUTES || 15) * 60,
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
);
app.post("/api/v1/auth/mfa/setup", async (req) => {
  const u = await auth(req);
  if (u.role === "patient")
    error(403, "MFA enrollment is for privileged accounts only");
  if (u.mfa_enabled) error(409, "MFA is already enabled");
  const secret = newTotpSecret(),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "UPDATE users SET mfa_secret=$1,mfa_last_counter=NULL WHERE id=$2",
      [encrypt(secret), u.id],
    );
    await audit(c, u.id, "mfa.setup", "user", u.id, String(req.id));
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  return {
    secret,
    otpauth_uri: `otpauth://totp/Amrutam:${encodeURIComponent(decrypt(u.email))}?secret=${secret}&issuer=Amrutam&algorithm=SHA1&digits=6&period=30`,
    enabled: false,
    instruction:
      "Add this secret to an authenticator app, then verify a current code.",
  };
});
app.post<{ Body: { totp_code: string } }>(
  "/api/v1/auth/mfa/verify",
  async (req) => {
    const u = await auth(req);
    if (u.role === "patient") error(403, "MFA is for privileged accounts");
    if (u.mfa_enabled) error(409, "MFA is already enabled");
    if (!u.mfa_secret) error(409, "Start MFA setup first");
    const ctr = verifyTotp(decrypt(u.mfa_secret), req.body?.totp_code || "");
    if (ctr === null) error(400, "Invalid or expired authenticator code");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "UPDATE users SET mfa_enabled=true,mfa_last_counter=$1 WHERE id=$2",
        [ctr, u.id],
      );
      await audit(c, u.id, "mfa.enable", "user", u.id, String(req.id));
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    return { enabled: true };
  },
);
app.get<{
  Querystring: {
    q?: string;
    specialty?: string;
    limit?: number;
    offset?: number;
  };
}>("/api/v1/doctors", async (req) => {
  const { q: term, specialty, limit = 20, offset = 0 } = req.query;
  const n = Math.min(100, Math.max(1, Number(limit) || 20)),
    o = Math.max(0, Number(offset) || 0);
  const rows = await q(
    "SELECT id,display_name,specialty FROM doctors WHERE active=true AND ($1::text IS NULL OR display_name ILIKE $2) AND ($3::text IS NULL OR specialty ILIKE $4) ORDER BY display_name LIMIT $5 OFFSET $6",
    [
      term || null,
      `%${term || ""}%`,
      specialty || null,
      `%${specialty || ""}%`,
      n,
      o,
    ],
  );
  return { items: rows, limit: n, offset: o };
});
app.get<{
  Params: { doctor_id: string };
  Querystring: { from_at: string; to_at: string };
}>("/api/v1/doctors/:doctor_id/availability", async (req) => {
  const { from_at, to_at } = req.query;
  if (!from_at || !to_at || new Date(from_at) >= new Date(to_at))
    error(422, "Valid from_at and to_at required");
  return {
    items: await q(
      "SELECT id,starts_at,ends_at FROM availability_slots WHERE doctor_id=$1 AND status=$2 AND starts_at >= $3 AND starts_at < $4 ORDER BY starts_at",
      [req.params.doctor_id, "available", from_at, to_at],
    ),
  };
});
app.post<{
  Params: { doctor_id: string };
  Body: { starts_at: string; ends_at: string };
}>("/api/v1/doctors/:doctor_id/availability", async (req, reply) => {
  const actor = await auth(req, ["doctor", "admin"]),
    { doctor_id } = req.params,
    { starts_at, ends_at } = req.body || {};
  const d = (
    await q("SELECT id,user_id FROM doctors WHERE id=$1", [doctor_id])
  )[0];
  if (!d || (actor.role === "doctor" && d.user_id !== actor.id))
    error(404, "Doctor not found");
  if (
    !starts_at ||
    !ends_at ||
    new Date(starts_at) <= new Date() ||
    new Date(ends_at) <= new Date(starts_at)
  )
    error(422, "Provide a future timezone-aware interval");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await q(
      "INSERT INTO availability_slots(id,doctor_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [randomUUID(), doctor_id, starts_at, ends_at, "available"],
      c,
    );
    await audit(
      c,
      actor.id,
      "availability.create",
      "slot",
      r[0]!.id,
      String(req.id),
    );
    await c.query("COMMIT");
    reply.code(201);
    return r[0];
  } catch {
    await c.query("ROLLBACK");
    error(409, "Slot conflicts with an existing start time");
  } finally {
    c.release();
  }
});
app.post<{ Body: { slot_id: string; reason: string } }>(
  "/api/v1/consultations",
  async (req, reply) => {
    const patient = await auth(req, ["patient"]),
      key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 128)
      error(400, "Idempotency-Key header is required (max 128 chars)");
    const { slot_id, reason } = req.body || {};
    if (
      !slot_id ||
      typeof reason !== "string" ||
      reason.length < 3 ||
      reason.length > 500
    )
      error(422, "slot_id and reason (3–500 characters) required");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `${patient.id}:${key}`,
      ]);
      const old = (
        await q(
          "SELECT id,status FROM consultations WHERE patient_id=$1 AND idempotency_key=$2",
          [patient.id, key],
          c,
        )
      )[0];
      if (old) {
        await c.query("COMMIT");
        reply.code(201);
        return { id: old.id, status: old.status, replayed: true };
      }
      const slot = (
        await q(
          "SELECT * FROM availability_slots WHERE id=$1 FOR UPDATE",
          [slot_id],
          c,
        )
      )[0];
      if (!slot || slot.status !== "available")
        error(409, "Slot is unavailable");
      const id = randomUUID();
      await c.query(
        "INSERT INTO consultations(id,patient_id,doctor_id,slot_id,status,idempotency_key,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          patient.id,
          slot.doctor_id,
          slot.id,
          "booked",
          key,
          encrypt(reason),
        ],
      );
      await c.query(
        "UPDATE availability_slots SET status='booked' WHERE id=$1",
        [slot.id],
      );
      await audit(
        c,
        patient.id,
        "consultation.book",
        "consultation",
        id,
        String(req.id),
      );
      await c.query("COMMIT");
      reply.code(201);
      return { id, status: "booked", replayed: false };
    } catch (e) {
      await c.query("ROLLBACK");
      if ((e as any).statusCode) throw e;
      error(409, "Booking conflict; retry with the same idempotency key");
    } finally {
      c.release();
    }
  },
);
app.get("/api/v1/consultations", async (req) => {
  const u = await auth(req);
  let sql =
    "SELECT id,patient_id,doctor_id,slot_id,status,created_at FROM consultations";
  let args: any[] = [];
  if (u.role === "patient") {
    sql += " WHERE patient_id=$1";
    args = [u.id];
  } else if (u.role === "doctor") {
    const d = (await q("SELECT id FROM doctors WHERE user_id=$1", [u.id]))[0];
    sql += " WHERE doctor_id=$1";
    args = [d?.id || ""];
  }
  sql += " ORDER BY created_at DESC LIMIT 100";
  return { items: await q(sql, args) };
});
app.patch<{ Params: { consultation_id: string }; Body: { status: string } }>(
  "/api/v1/consultations/:consultation_id/status",
  async (req) => {
    const u = await auth(req),
      { consultation_id } = req.params,
      { status } = req.body || {};
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const item = (
        await q(
          "SELECT * FROM consultations WHERE id=$1 FOR UPDATE",
          [consultation_id],
          c,
        )
      )[0];
      if (!item) error(404, "Consultation not found");
      const doc =
        u.role === "doctor"
          ? (await q("SELECT id FROM doctors WHERE user_id=$1", [u.id]))[0]
          : null;
      if (
        u.role !== "admin" &&
        u.id !== item.patient_id &&
        doc?.id !== item.doctor_id
      )
        error(403, "Not permitted");
      const allowed: Record<string, string[]> = {
        booked: ["in_progress", "cancelled"],
        in_progress: ["completed", "cancelled"],
        completed: [],
        cancelled: [],
      };
      if (!allowed[item.status]?.includes(status))
        error(
          u.role === "patient" && status !== "cancelled" ? 403 : 409,
          u.role === "patient" && status !== "cancelled"
            ? "Patients can only cancel"
            : "Invalid lifecycle transition",
        );
      await c.query("UPDATE consultations SET status=$1 WHERE id=$2", [
        status,
        consultation_id,
      ]);
      await audit(
        c,
        u.id,
        "consultation.status_change",
        "consultation",
        consultation_id,
        String(req.id),
      );
      await c.query("COMMIT");
      return { id: consultation_id, status };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
);
app.post<{ Params: { consultation_id: string }; Body: { body: string } }>(
  "/api/v1/consultations/:consultation_id/prescriptions",
  async (req, reply) => {
    const u = await auth(req, ["doctor", "admin"]),
      { consultation_id } = req.params,
      { body } = req.body || {};
    if (typeof body !== "string" || body.length < 2 || body.length > 10000)
      error(422, "Prescription body (2–10000 characters) required");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const item = (
        await q("SELECT * FROM consultations WHERE id=$1", [consultation_id], c)
      )[0];
      const doc =
        u.role === "doctor"
          ? (await q("SELECT id FROM doctors WHERE user_id=$1", [u.id]))[0]
          : null;
      if (!item || (u.role === "doctor" && doc?.id !== item.doctor_id))
        error(404, "Consultation not found");
      if (!["in_progress", "completed"].includes(item.status))
        error(409, "Consultation must be in progress or completed");
      const id = randomUUID();
      await c.query(
        "INSERT INTO prescriptions(id,consultation_id,doctor_id,body,created_at) VALUES($1,$2,$3,$4,$5)",
        [id, consultation_id, item.doctor_id, encrypt(body), new Date()],
      );
      await audit(
        c,
        u.id,
        "prescription.create",
        "prescription",
        id,
        String(req.id),
      );
      await c.query("COMMIT");
      reply.code(201);
      return { id, consultation_id, created_at: new Date().toISOString() };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
);
app.get<{ Params: { consultation_id: string } }>(
  "/api/v1/consultations/:consultation_id/prescriptions",
  async (req) => {
    const u = await auth(req),
      { consultation_id } = req.params;
    const item = (
      await q("SELECT * FROM consultations WHERE id=$1", [consultation_id])
    )[0];
    const doc =
      u.role === "doctor"
        ? (await q("SELECT id FROM doctors WHERE user_id=$1", [u.id]))[0]
        : null;
    if (
      !item ||
      (u.role === "patient" && item.patient_id !== u.id) ||
      (u.role === "doctor" && doc?.id !== item.doctor_id)
    )
      error(404, "Consultation not found");
    const rows = await q<{ id: string; body: Buffer; created_at: Date }>(
      "SELECT id,body,created_at FROM prescriptions WHERE consultation_id=$1",
      [consultation_id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        body: decrypt(r.body),
        created_at: r.created_at,
      })),
    };
  },
);
app.post<{
  Body: {
    email: string;
    password: string;
    display_name: string;
    specialty: string;
  };
}>("/api/v1/admin/doctors", async (req, reply) => {
  const admin = await auth(req, ["admin"]),
    b = req.body || {};
  if (
    !emailRe.test(b.email || "") ||
    !b.display_name ||
    b.display_name.length < 2 ||
    !b.specialty ||
    b.specialty.length < 2 ||
    !b.password ||
    b.password.length < 12 ||
    b.password.length > 72
  )
    error(422, "Valid email, password, display_name, and specialty required");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const hash = lookupHash(b.email);
    if (
      (await q("SELECT 1 FROM users WHERE email_lookup_hash=$1", [hash], c))
        .length
    )
      error(409, "Account already exists");
    const uid = randomUUID(),
      did = randomUUID();
    await c.query(
      "INSERT INTO users(id,email,email_lookup_hash,password_hash,role) VALUES($1,$2,$3,$4,$5)",
      [uid, encrypt(b.email), hash, await hashPassword(b.password), "doctor"],
    );
    await c.query(
      "INSERT INTO doctors(id,user_id,display_name,specialty) VALUES($1,$2,$3,$4)",
      [did, uid, b.display_name, b.specialty],
    );
    await audit(c, admin.id, "doctor.create", "doctor", did, String(req.id));
    await c.query("COMMIT");
    reply.code(201);
    return {
      id: did,
      user_id: uid,
      display_name: b.display_name,
      specialty: b.specialty,
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
});
app.get("/api/v1/admin/analytics", async (req) => {
  await auth(req, ["admin"]);
  const statuses = await q<{ status: string; count: string }>(
    "SELECT status,count(*)::int count FROM consultations GROUP BY status",
  );
  const users = await q<{ count: string }>(
    "SELECT count(*)::int count FROM users",
  );
  const doctors = await q<{ count: string }>(
    "SELECT count(*)::int count FROM doctors WHERE active=true",
  );
  return {
    consultations_by_status: Object.fromEntries(
      statuses.map((x) => [x.status, x.count]),
    ),
    total_users: Number(users[0]?.count || 0),
    active_doctors: Number(doctors[0]?.count || 0),
  };
});
app.setErrorHandler((e, req, reply) => {
  const status = (e as any).statusCode || 500;
  if (status >= 500)
    req.log.error({ err: e, requestId: req.id }, "request failed");
  reply.code(status).send({
    detail: status >= 500 ? "Internal server error" : (e as Error).message,
  });
});
app.addHook("onClose", async () => {
  await pool.end();
  redis?.disconnect();
});
if (env.NODE_ENV !== "test")
  await app.listen({
    port: Number(env.PORT || 8000),
    host: env.HOST || "0.0.0.0",
  });
