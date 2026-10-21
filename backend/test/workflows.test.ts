import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
const configured = process.env.TEST_DATABASE_URL;
const testMode = Boolean(
  configured && new URL(configured).pathname.toLowerCase().includes("test"),
);
test(
  "REST critical flows: auth, protected booking, idempotency, lifecycle, prescription, isolation",
  { skip: !testMode },
  async () => {
    if (!configured || !testMode)
      throw Error(
        'Integration tests require a dedicated TEST_DATABASE_URL whose database name includes "test"',
      );
    process.env.NODE_ENV = "test";
    process.env.APP_ENV = "development";
    process.env.JWT_SECRET =
      "integration-test-secret-at-least-32-characters-long";
    const { app, pool } = await import("../src/server.js");
    const setup = new Pool({ connectionString: configured });
    try {
      await setup.query(
        await readFile(
          new URL("../../database/schema.sql", import.meta.url),
          "utf8",
        ),
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
        200,
      );
      const suffix = randomUUID(),
        patientEmail = `test-patient-${suffix}@example.test`,
        doctorEmail = `test-doctor-${suffix}@example.test`,
        otherEmail = `test-other-${suffix}@example.test`,
        pass = "safe-integration-password-123";
      let r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email: patientEmail, password: pass },
      });
      assert.equal(r.statusCode, 201);
      r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email: `bad-${suffix}@example.test`,
          password: pass,
          role: "admin",
        },
      });
      assert.equal(r.statusCode, 403);
      const patientToken = (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: patientEmail, password: pass },
        })
      ).json().access_token;
      const secondPatientEmail = `second-patient-${suffix}@example.test`;
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: { email: secondPatientEmail, password: pass },
          })
        ).statusCode,
        201,
      );
      const secondPatientToken = (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: secondPatientEmail, password: pass },
        })
      ).json().access_token;
      const pRow = (
        await setup.query(
          "SELECT email FROM users WHERE email_lookup_hash=$1",
          [(await import("../src/security.js")).lookupHash(patientEmail)],
        )
      ).rows[0];
      assert.ok(!Buffer.from(pRow.email).includes(Buffer.from(patientEmail)));
      async function makeDoctor(email: string, name: string) {
        const sec = (await import("../src/security.js")).demoTotpSecret(email),
          id = randomUUID(),
          docId = randomUUID();
        await setup.query(
          "INSERT INTO users(id,email,email_lookup_hash,password_hash,role,mfa_secret,mfa_enabled) VALUES($1,$2,$3,$4,$5,$6,true)",
          [
            id,
            (await import("../src/security.js")).encrypt(email),
            (await import("../src/security.js")).lookupHash(email),
            await (await import("bcrypt")).hash(pass, 4),
            "doctor",
            (await import("../src/security.js")).encrypt(sec),
          ],
        );
        await setup.query(
          "INSERT INTO doctors(id,user_id,display_name,specialty) VALUES($1,$2,$3,$4)",
          [docId, id, name, "General Medicine"],
        );
        return { id, docId, secret: sec };
      }
      const doctor = await makeDoctor(doctorEmail, "Integration Doctor"),
        other = await makeDoctor(otherEmail, "Other Doctor");
      const slot = randomUUID();
      await setup.query(
        "INSERT INTO availability_slots(id,doctor_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5)",
        [
          slot,
          doctor.docId,
          new Date(Date.now() + 86400000),
          new Date(Date.now() + 90000000),
          "available",
        ],
      );
      const code = (await import("../src/security.js")).totpCounter(
        doctor.secret,
        Math.floor(Date.now() / 30000),
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: doctorEmail, password: pass, totp_code: code },
      });
      assert.equal(login.statusCode, 200);
      const doctorToken = login.json().access_token;
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email: doctorEmail, password: pass, totp_code: code },
          })
        ).statusCode,
        401,
        "a TOTP counter cannot be replayed",
      );
      const headers = {
        authorization: `Bearer ${patientToken}`,
        "idempotency-key": `booking-${suffix}`,
      };
      const body = { slot_id: slot, reason: "Routine integration visit" };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/consultations",
        headers,
        payload: body,
      });
      assert.equal(first.statusCode, 201, first.body);
      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/consultations",
        headers,
        payload: body,
      });
      assert.equal(replay.statusCode, 201);
      assert.equal(replay.json().id, first.json().id);
      assert.equal(replay.json().replayed, true);
      const conflict = await app.inject({
        method: "POST",
        url: "/api/v1/consultations",
        headers: { ...headers, "idempotency-key": `other-${suffix}` },
        payload: body,
      });
      assert.equal(conflict.statusCode, 409);
      const contestedSlot = randomUUID();
      await setup.query(
        "INSERT INTO availability_slots(id,doctor_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,'available')",
        [
          contestedSlot,
          other.docId,
          new Date(Date.now() + 172800000),
          new Date(Date.now() + 176400000),
        ],
      );
      const concurrent = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/consultations",
          headers: {
            authorization: `Bearer ${patientToken}`,
            "idempotency-key": `parallel-a-${suffix}`,
          },
          payload: { slot_id: contestedSlot, reason: "Parallel booking check" },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/consultations",
          headers: {
            authorization: `Bearer ${secondPatientToken}`,
            "idempotency-key": `parallel-b-${suffix}`,
          },
          payload: { slot_id: contestedSlot, reason: "Parallel booking check" },
        }),
      ]);
      assert.deepEqual(
        concurrent.map((response) => response.statusCode).sort(),
        [201, 409],
      );
      const consultId = first.json().id;
      const doctorHeaders = { authorization: `Bearer ${doctorToken}` };
      const visible = await app.inject({
        method: "GET",
        url: "/api/v1/consultations",
        headers: doctorHeaders,
      });
      assert.ok(visible.json().items.some((x: any) => x.id === consultId));
      const transition = await app.inject({
        method: "PATCH",
        url: `/api/v1/consultations/${consultId}/status`,
        headers: doctorHeaders,
        payload: { status: "in_progress" },
      });
      assert.equal(transition.statusCode, 200);
      const prescription = await app.inject({
        method: "POST",
        url: `/api/v1/consultations/${consultId}/prescriptions`,
        headers: doctorHeaders,
        payload: { body: "Synthetic integration care plan" },
      });
      assert.equal(prescription.statusCode, 201);
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/consultations/${consultId}/prescriptions`,
        headers: doctorHeaders,
      });
      assert.equal(
        read.json().items[0].body,
        "Synthetic integration care plan",
      );
      const patientRead = await app.inject({
        method: "GET",
        url: `/api/v1/consultations/${consultId}/prescriptions`,
        headers: { authorization: `Bearer ${patientToken}` },
      });
      assert.equal(patientRead.statusCode, 200);
      const otherCode = (await import("../src/security.js")).totpCounter(
        other.secret,
        Math.floor(Date.now() / 30000),
      );
      const otherLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: otherEmail, password: pass, totp_code: otherCode },
      });
      assert.equal(otherLogin.statusCode, 200);
      const denied = await app.inject({
        method: "PATCH",
        url: `/api/v1/consultations/${consultId}/status`,
        headers: { authorization: `Bearer ${otherLogin.json().access_token}` },
        payload: { status: "completed" },
      });
      assert.ok([403, 404].includes(denied.statusCode));
      const patientPrescription = await app.inject({
        method: "POST",
        url: `/api/v1/consultations/${consultId}/prescriptions`,
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { body: "should be denied" },
      });
      assert.equal(patientPrescription.statusCode, 403);
      const noAdmin = await app.inject({
        method: "GET",
        url: "/api/v1/admin/analytics",
        headers: { authorization: `Bearer ${patientToken}` },
      });
      assert.equal(noAdmin.statusCode, 403);
    } finally {
      await setup.end();
      await app.close();
    }
  },
);
