import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = new URL("../../", import.meta.url);
test("PostgreSQL schema retains idempotency, unique-slot, and audit constraints", async () => {
  const schema = await readFile(new URL("database/schema.sql", root), "utf8");
  assert.match(schema, /UNIQUE\(patient_id, idempotency_key\)/i);
  assert.match(schema, /slot_id varchar\(36\) not null unique/i);
  assert.match(schema, /CREATE TABLE audit_logs/i);
});
test("OpenAPI contract and reviewer demo cues remain present", async () => {
  const api = await readFile(new URL("api/openapi.yaml", root), "utf8"),
    demo = await readFile(new URL("docs/demo-script.md", root), "utf8");
  for (const route of [
    "/api/v1/auth/register",
    "/api/v1/consultations",
    "/api/v1/admin/analytics",
    "/metrics",
  ])
    assert.ok(api.includes(route), `missing ${route}`);
  for (const cue of ["0:00", "1:10", "2:20", "3:15", "4:05"])
    assert.ok(demo.includes(cue), `missing ${cue}`);
});
