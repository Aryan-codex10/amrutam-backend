"""Field encryption, email lookup digests, and RFC 6238 TOTP helpers."""
import base64
import hashlib
import hmac
import os
import struct
import time
from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet
from sqlalchemy.types import LargeBinary, TypeDecorator

_DEV_ENCRYPTION_KEY = base64.urlsafe_b64encode(hashlib.sha256(b"amrutam-local-demo-encryption-key-only").digest()).decode()
_DEV_LOOKUP_KEY = "amrutam-local-demo-email-lookup-key-only"


@lru_cache(maxsize=1)
def _fernet() -> MultiFernet:
    configured = os.getenv("PHI_ENCRYPTION_KEYS", "")
    if configured:
        keys = [key.strip().encode() for key in configured.split(",") if key.strip()]
    elif os.getenv("APP_ENV", "development") == "development":
        keys = [_DEV_ENCRYPTION_KEY.encode()]
    else:
        raise RuntimeError("PHI_ENCRYPTION_KEYS must be configured outside development")
    try:
        return MultiFernet([Fernet(key) for key in keys])
    except (ValueError, TypeError) as exc:
        raise RuntimeError("PHI_ENCRYPTION_KEYS must contain URL-safe base64 Fernet keys") from exc


def email_lookup_hash(email: str) -> str:
    key = os.getenv("EMAIL_LOOKUP_KEY", _DEV_LOOKUP_KEY).encode()
    normalized = email.strip().lower().encode()
    return hmac.new(key, normalized, hashlib.sha256).hexdigest()


class EncryptedText(TypeDecorator):
    """Encrypt text before it reaches the database; use BYTEA on PostgreSQL."""
    impl = LargeBinary
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return _fernet().encrypt(str(value).encode("utf-8"))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return _fernet().decrypt(bytes(value)).decode("utf-8")


def new_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def demo_totp_secret(email: str) -> str:
    """Predictable second factors are only for public synthetic demo accounts."""
    value = hashlib.sha256(f"amrutam-demo-totp:{email.strip().lower()}".encode()).digest()
    return base64.b32encode(value).decode("ascii").rstrip("=")


def totp_counter(secret: str, counter: int) -> str:
    padded = secret.upper() + "=" * (-len(secret) % 8)
    key = base64.b32decode(padded, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{binary % 1_000_000:06d}"


def verify_totp(secret: str, code: str, now: float | None = None) -> int | None:
    if len(code) != 6 or not code.isdigit():
        return None
    current = int((time.time() if now is None else now) // 30)
    matches = [counter for counter in (current - 1, current, current + 1) if hmac.compare_digest(totp_counter(secret, counter), code)]
    return max(matches) if matches else None


def require_production_keys() -> None:
    if os.getenv("APP_ENV", "development") == "development":
        return
    if not os.getenv("PHI_ENCRYPTION_KEYS") or len(os.getenv("EMAIL_LOOKUP_KEY", "")) < 32:
        raise RuntimeError("Production requires PHI_ENCRYPTION_KEYS and an EMAIL_LOOKUP_KEY of at least 32 characters")
    _fernet()
