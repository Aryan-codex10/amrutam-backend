"""HTTP workflow tests use an isolated in-memory SQLite database."""
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.app.main import Base, Doctor, Slot, User, app, db
from src.app.security import demo_totp_secret, email_lookup_hash, totp_counter

class ApiWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        cls.Session = sessionmaker(bind=cls.engine, expire_on_commit=False)
        Base.metadata.create_all(cls.engine)
        def override_db():
            session = cls.Session()
            try: yield session
            finally: session.close()
        app.dependency_overrides[db] = override_db
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()
        Base.metadata.drop_all(cls.engine)
        cls.engine.dispose()

    def setUp(self):
        Base.metadata.drop_all(self.engine)
        Base.metadata.create_all(self.engine)
        self.patient_email = f"patient-{uuid.uuid4()}@example.com"
        response = self.client.post("/api/v1/auth/register", json={"email":self.patient_email,"password":"safe-demo-password-123"})
        self.assertEqual(response.status_code, 201, response.text)
        token = self.client.post("/api/v1/auth/login", json={"email":self.patient_email,"password":"safe-demo-password-123"}).json()["access_token"]
        self.headers = {"Authorization":f"Bearer {token}"}
        with self.Session() as session:
            user = User(email=f"doc-{uuid.uuid4()}@example.com",password_hash="not-used",role="doctor")
            session.add(user); session.flush()
            doctor = Doctor(user_id=user.id,display_name="Demo Doctor",specialty="General Medicine")
            session.add(doctor); session.flush()
            slot = Slot(doctor_id=doctor.id,starts_at=datetime.now(timezone.utc)+timedelta(days=2),ends_at=datetime.now(timezone.utc)+timedelta(days=2,hours=1),status="available")
            session.add(slot); session.commit()
            self.slot_id = slot.id

    def test_registration_cannot_self_assign_privileged_role(self):
        response = self.client.post("/api/v1/auth/register",json={"email":f"role-{uuid.uuid4()}@example.com","password":"safe-demo-password-123","role":"admin"})
        self.assertEqual(response.status_code,403)

    def test_email_is_encrypted_at_rest_and_still_login_searchable(self):
        with self.engine.connect() as connection:
            stored = connection.execute(text("SELECT email FROM users WHERE email_lookup_hash=:lookup"), {"lookup":email_lookup_hash(self.patient_email)}).scalar_one()
        self.assertNotIn(self.patient_email.encode(), bytes(stored))
        login = self.client.post("/api/v1/auth/login",json={"email":self.patient_email,"password":"safe-demo-password-123"})
        self.assertEqual(login.status_code,200,login.text)

    def test_privileged_login_requires_non_replayed_totp(self):
        email=f"admin-{uuid.uuid4()}@example.com"
        with self.Session() as session:
            admin=User(email=email,password_hash=bcrypt.hashpw(b"safe-admin-password-123",bcrypt.gensalt()).decode(),role="admin",mfa_secret=demo_totp_secret(email),mfa_enabled=True)
            session.add(admin); session.commit()
        base={"email":email,"password":"safe-admin-password-123"}
        missing=self.client.post("/api/v1/auth/login",json=base)
        counter=int(datetime.now(timezone.utc).timestamp()//30)
        code=totp_counter(demo_totp_secret(email),counter)
        accepted=self.client.post("/api/v1/auth/login",json={**base,"totp_code":code})
        replay=self.client.post("/api/v1/auth/login",json={**base,"totp_code":code})
        self.assertEqual(missing.status_code,401)
        self.assertEqual(accepted.status_code,200,accepted.text)
        self.assertEqual(replay.status_code,401)

    def test_booking_is_idempotent_and_slot_cannot_be_double_booked(self):
        body={"slot_id":self.slot_id,"reason":"Routine follow-up"}
        first=self.client.post("/api/v1/consultations",json=body,headers={**self.headers,"Idempotency-Key":"booking-001"})
        replay=self.client.post("/api/v1/consultations",json=body,headers={**self.headers,"Idempotency-Key":"booking-001"})
        conflict=self.client.post("/api/v1/consultations",json=body,headers={**self.headers,"Idempotency-Key":"booking-002"})
        self.assertEqual(first.status_code,201,first.text)
        self.assertEqual(replay.status_code,201,replay.text)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(first.json()["id"],replay.json()["id"])
        self.assertEqual(conflict.status_code,409)

if __name__ == "__main__":
    unittest.main()
