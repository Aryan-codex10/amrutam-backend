"""Lightweight contract checks; Postgres integration/concurrency tests are a production follow-up."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class ContractTests(unittest.TestCase):
    def test_openapi_core_paths(self):
        text = (ROOT / "api/openapi.yaml").read_text()
        for route in ("/api/v1/auth/register", "/api/v1/consultations", "/api/v1/admin/analytics", "/metrics"):
            self.assertIn(route, text)

    def test_schema_booking_guards(self):
        text = (ROOT / "database/schema.sql").read_text().lower()
        self.assertIn("unique(patient_id,idempotency_key)", text)
        self.assertIn("slot_id uuid not null unique", text)
        self.assertIn("audit_logs", text)

    def test_demo_sections(self):
        text = (ROOT / "docs/demo-script.md").read_text(encoding="utf-8")
        for stamp in ("0:00", "1:10", "2:20", "3:15", "4:05"):
            self.assertIn(stamp, text)

if __name__ == "__main__":
    unittest.main()
