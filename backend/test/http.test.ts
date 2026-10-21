import { test } from "node:test";
import assert from "node:assert/strict";

test("health, metrics, OpenAPI JSON, and Swagger UI respond over HTTP", async () => {
  process.env.NODE_ENV = "test";
  process.env.APP_ENV = "development";
  const { app } = await import("../src/server.js");
  try {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().status, "alive");
    assert.ok(live.headers["x-request-id"]);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.body, /http_requests_total/);

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.json().info.title, "Amrutam Telemedicine API");
    assert.ok(Object.keys(openapi.json().paths).includes("/api/v1/auth/login"));

    const contract = await app.inject({ method: "GET", url: "/openapi.yaml" });
    assert.equal(contract.statusCode, 200);
    assert.match(contract.body, /Idempotency-Key/);

    const docs = await app.inject({ method: "GET", url: "/docs" });
    assert.equal(docs.statusCode, 200);
    assert.match(docs.body, /swagger/i);
  } finally {
    await app.close();
  }
});
