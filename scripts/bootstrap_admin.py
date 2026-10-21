"""Create the first local admin account; run manually with credentials from environment."""
import os
import sys

import bcrypt
from sqlalchemy import select

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from src.app.main import SessionLocal, User
from src.app.security import email_lookup_hash

email = os.environ.get("BOOTSTRAP_ADMIN_EMAIL")
password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD")
if not email or not password or len(password) < 16:
    raise SystemExit("Set BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 16 characters")
with SessionLocal() as session:
    if session.scalar(select(User).where(User.role == "admin")):
        raise SystemExit("An admin already exists; bootstrap is first-admin-only")
    if session.scalar(select(User).where(User.email_lookup_hash == email_lookup_hash(email))):
        raise SystemExit("That email already exists")
    session.add(User(email=email, password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(), role="admin"))
    session.commit()
print("Initial admin created. Unset the bootstrap environment variables now.")
