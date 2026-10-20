"""Create a repeatable, synthetic 20-user demo dataset (development only)."""
import argparse
import os
import sys
import uuid
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bcrypt
from sqlalchemy import func, select

from src.app.main import Base, Consultation, Doctor, Prescription, SessionLocal, Slot, User, engine

NAMESPACE = uuid.UUID("24d9bc4f-fb1e-4f93-b077-7c152b5ecb4a")
ADMIN_EMAIL = "admin.demo@example.com"
ADMIN_PASSWORD = "Demo-Admin-2026!"
DOCTOR_PASSWORD = "Demo-Doctor-2026!"
PATIENT_PASSWORD = "Demo-Patient-2026!"
DOCTORS = [
    ("Aarav Mehta", "General Medicine"),
    ("Diya Shah", "Cardiology"),
    ("Kabir Rao", "Dermatology"),
    ("Mira Iyer", "Pediatrics"),
    ("Neel Kapoor", "Orthopedics"),
]


def stable_id(kind: str) -> str:
    return str(uuid.uuid5(NAMESPACE, kind))


def get_or_create_user(session, email: str, role: str, password: str) -> tuple[User, bool]:
    user = session.scalar(select(User).where(User.email == email))
    if user:
        if user.role != role:
            raise RuntimeError(f"{email} exists with role={user.role}; expected role={role}")
        return user, False
    user = User(
        id=stable_id(f"user:{email}"),
        email=email,
        password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        role=role,
        is_active=True,
    )
    session.add(user)
    session.flush()
    return user, True


def seed() -> dict[str, int]:
    if os.getenv("APP_ENV", "development") != "development":
        raise RuntimeError("Demo seeding is allowed only when APP_ENV=development")

    Base.metadata.create_all(engine)
    added_users = 0
    added_doctors = 0
    added_slots = 0
    added_consultations = 0
    added_prescriptions = 0
    with SessionLocal.begin() as session:
        admin, created = get_or_create_user(session, ADMIN_EMAIL, "admin", ADMIN_PASSWORD)
        added_users += int(created)

        doctor_rows = []
        for index, (name, specialty) in enumerate(DOCTORS, start=1):
            email = f"doctor{index:02d}.demo@example.com"
            user, created = get_or_create_user(session, email, "doctor", DOCTOR_PASSWORD)
            added_users += int(created)
            doctor = session.scalar(select(Doctor).where(Doctor.user_id == user.id))
            if doctor is None:
                doctor = Doctor(id=stable_id(f"doctor:{index}"), user_id=user.id, display_name=name, specialty=specialty, active=True)
                session.add(doctor)
                session.flush()
                added_doctors += 1
            else:
                doctor.display_name = name
                doctor.specialty = specialty
                doctor.active = True
            doctor_rows.append((user, doctor))

        patient_rows = []
        for index in range(1, 15):
            email = f"patient{index:02d}.demo@example.com"
            user, created = get_or_create_user(session, email, "patient", PATIENT_PASSWORD)
            added_users += int(created)
            patient_rows.append(user)

        now = datetime.now(timezone.utc)
        starts = []
        for index, (doctor_user, doctor) in enumerate(doctor_rows, start=1):
            day = (now + timedelta(days=3 + index)).date()
            starts.append(datetime.combine(day, time(10, 0), tzinfo=timezone.utc))

        consultation_statuses = ["booked", "in_progress", "completed", "cancelled", "booked"]
        seeded_consultations = []
        for index, ((doctor_user, doctor), start_at) in enumerate(zip(doctor_rows, starts), start=1):
            for slot_number, slot_start in ((1, start_at), (2, start_at + timedelta(days=1, hours=1))):
                slot_id = stable_id(f"slot:{index}:{slot_number}")
                slot = session.get(Slot, slot_id)
                if slot is None:
                    slot = Slot(id=slot_id, doctor_id=doctor.id, starts_at=slot_start, ends_at=slot_start + timedelta(minutes=30), status="available")
                    session.add(slot)
                    session.flush()
                    added_slots += 1
                else:
                    slot.starts_at = slot_start
                    slot.ends_at = slot_start + timedelta(minutes=30)
                if slot_number == 2:
                    continue

                patient = patient_rows[index - 1]
                consultation_id = stable_id(f"consultation:{index}")
                consultation = session.get(Consultation, consultation_id)
                desired_status = consultation_statuses[index - 1]
                if consultation is None:
                    consultation = Consultation(
                        id=consultation_id,
                        patient_id=patient.id,
                        doctor_id=doctor.id,
                        slot_id=slot.id,
                        status=desired_status,
                        idempotency_key=f"demo-seed-v1-{index}",
                        reason="Synthetic demo visit; no real health information.",
                    )
                    session.add(consultation)
                    session.flush()
                    added_consultations += 1
                slot.status = "available" if consultation.status == "cancelled" else "booked"
                seeded_consultations.append((index, consultation, doctor))

        for index, consultation, doctor in seeded_consultations:
            if consultation.status not in ("in_progress", "completed"):
                continue
            prescription_id = stable_id(f"prescription:{index}")
            if session.get(Prescription, prescription_id) is None:
                session.add(Prescription(
                    id=prescription_id,
                    consultation_id=consultation.id,
                    doctor_id=doctor.id,
                    body="Synthetic demo prescription: sample instructions only; not medical advice.",
                ))
                added_prescriptions += 1

        session.flush()
        actual_users = session.scalar(select(func.count()).select_from(User))

    return {
        "demo_users_total": 20,
        "users_added_this_run": added_users,
        "doctors_added_this_run": added_doctors,
        "slots_added_this_run": added_slots,
        "consultations_added_this_run": added_consultations,
        "prescriptions_added_this_run": added_prescriptions,
        "users_in_database": actual_users,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true", help="confirm that synthetic demo records will be added")
    args = parser.parse_args()
    if not args.confirm:
        parser.error("pass --confirm to seed the local development database")
    counts = seed()
    print("Synthetic demo seed complete:")
    for name, value in counts.items():
        print(f"  {name}: {value}")
    print("Use the demo credentials documented in docs/demo-seed-accounts.md.")


if __name__ == "__main__":
    main()
