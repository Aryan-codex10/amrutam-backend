"""Encrypt the earlier plaintext demo database in place. Development only."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import inspect, text

from src.app.main import Base, engine
from src.app.security import _fernet, email_lookup_hash


def column_map(connection, table: str):
    return {column["name"]: column for column in inspect(connection).get_columns(table)}


def encrypt_legacy_column(connection, table: str, old_column: str, new_column: str):
    columns = column_map(connection, table)
    if old_column not in columns or "bytea" in str(columns[old_column]["type"]).lower():
        return False
    connection.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{new_column}" BYTEA'))
    rows = connection.execute(text(f'SELECT id, "{old_column}" FROM "{table}"')).all()
    for row_id, value in rows:
        encrypted = _fernet().encrypt((value or "").encode("utf-8"))
        connection.execute(text(f'UPDATE "{table}" SET "{new_column}"=:value WHERE id=:row_id'), {"value": encrypted, "row_id": row_id})
    connection.execute(text(f'ALTER TABLE "{table}" ALTER COLUMN "{new_column}" SET NOT NULL'))
    connection.execute(text(f'ALTER TABLE "{table}" DROP COLUMN "{old_column}"'))
    connection.execute(text(f'ALTER TABLE "{table}" RENAME COLUMN "{new_column}" TO "{old_column}"'))
    return True


def reconcile_email_lookup_hashes(connection):
    """Rebuild lookup digests using the active lookup key after decrypting emails."""
    columns = column_map(connection, "users")
    if "email_lookup_hash" not in columns or "email" not in columns:
        raise RuntimeError("users.email and users.email_lookup_hash must exist after schema migration")
    encrypted = "bytea" in str(columns["email"]["type"]).lower()
    rows = connection.execute(text("SELECT id, email FROM users")).all()
    for user_id, stored_email in rows:
        if stored_email is None:
            raise RuntimeError(f"User {user_id} has no email; refusing to rebuild lookup hashes")
        if encrypted:
            # InvalidToken is intentionally allowed to abort the transaction: the active
            # encryption key does not match the key needed to read this database.
            clear_email = _fernet().decrypt(bytes(stored_email)).decode("utf-8")
        else:
            clear_email = str(stored_email)
        normalized = clear_email.strip().lower()
        connection.execute(
            text("UPDATE users SET email_lookup_hash=:lookup WHERE id=:id"),
            {"lookup": email_lookup_hash(normalized), "id": user_id},
        )
    return len(rows)


def migrate():
    if os.getenv("APP_ENV", "development") != "development":
        raise RuntimeError("This convenience migration is development-only; production needs reviewed versioned migrations")
    if engine.dialect.name != "postgresql":
        raise RuntimeError("This migration supports the PostgreSQL Compose database only")

    # Creates missing tables on a new database and leaves existing table definitions untouched.
    Base.metadata.create_all(engine)
    migrated = {"emails": 0, "consultation_reasons": 0, "prescription_bodies": 0}
    with engine.begin() as connection:
        user_columns = column_map(connection, "users")
        if "email_lookup_hash" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN email_ciphertext BYTEA"))
            connection.execute(text("ALTER TABLE users ADD COLUMN email_lookup_hash VARCHAR(64)"))
            connection.execute(text("ALTER TABLE users ADD COLUMN mfa_secret BYTEA"))
            connection.execute(text("ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE"))
            connection.execute(text("ALTER TABLE users ADD COLUMN mfa_last_counter BIGINT"))
            rows = connection.execute(text("SELECT id, email FROM users")).all()
            for user_id, email in rows:
                normalized = (email or "").strip().lower()
                connection.execute(
                    text("UPDATE users SET email_ciphertext=:ciphertext, email_lookup_hash=:lookup WHERE id=:id"),
                    {"ciphertext": _fernet().encrypt(normalized.encode()), "lookup": email_lookup_hash(normalized), "id": user_id},
                )
                migrated["emails"] += 1
            connection.execute(text("ALTER TABLE users ALTER COLUMN email_ciphertext SET NOT NULL"))
            connection.execute(text("ALTER TABLE users ALTER COLUMN email_lookup_hash SET NOT NULL"))
            connection.execute(text("ALTER TABLE users DROP COLUMN email"))
            connection.execute(text("ALTER TABLE users RENAME COLUMN email_ciphertext TO email"))
            connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_lookup_hash ON users(email_lookup_hash)"))

        migrated["emails"] = max(migrated["emails"], reconcile_email_lookup_hashes(connection))

        if encrypt_legacy_column(connection, "consultations", "reason", "reason_ciphertext"):
            migrated["consultation_reasons"] = 1
        if encrypt_legacy_column(connection, "prescriptions", "body", "body_ciphertext"):
            migrated["prescription_bodies"] = 1

    return migrated


if __name__ == "__main__":
    results = migrate()
    print("Database encryption migration complete:")
    for name, count in results.items():
        print(f"  {name}: {count}")
    print("Existing MFA is disabled. Admin and doctor users must enroll before privileged APIs work.")
