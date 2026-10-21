"""Re-encrypt local demo rows with the first configured Fernet key. Development only."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from src.app.main import (Consultation, Profile, Prescription, SessionLocal, User)
from src.app.security import _DEV_ENCRYPTION_KEY, _fernet, email_lookup_hash


def rotate():
    if os.getenv("APP_ENV", "development") != "development":
        raise RuntimeError("This convenience script is development-only; use a reviewed production rotation job")
    keys = [item.strip() for item in os.getenv("PHI_ENCRYPTION_KEYS", "").split(",") if item.strip()]
    if len(keys) < 2:
        raise RuntimeError("Set PHI_ENCRYPTION_KEYS to NEW_KEY,OLD_KEY before rotating local records")
    # Include the stable earlier local demo key so rows encrypted before this
    # rotation remain readable while the new key is active.
    if _DEV_ENCRYPTION_KEY not in keys:
        keys.append(_DEV_ENCRYPTION_KEY)
        os.environ["PHI_ENCRYPTION_KEYS"] = ",".join(keys)
    _fernet()  # Validate configured keys before changing rows.

    with SessionLocal.begin() as session:
        users = session.scalars(select(User)).all()
        profiles = session.scalars(select(Profile)).all()
        consultations = session.scalars(select(Consultation)).all()
        prescriptions = session.scalars(select(Prescription)).all()
        for user in users:
            user.email_lookup_hash = email_lookup_hash(user.email)
            for field in ("email", "mfa_secret"):
                if getattr(user, field) is not None:
                    flag_modified(user, field)
        for profile in profiles:
            for field in ("phone_ciphertext", "date_of_birth_ciphertext"):
                if getattr(profile, field) is not None:
                    flag_modified(profile, field)
        for item in consultations:
            flag_modified(item, "reason")
        for item in prescriptions:
            flag_modified(item, "body")
        counts = (len(users), len(profiles), len(consultations), len(prescriptions))
    return counts


if __name__ == "__main__":
    result = rotate()
    print("Local key rotation complete (users, profiles, consultations, prescriptions):", result)
    print("Keep the old encryption key until backups and all database copies have been re-encrypted and verified.")
