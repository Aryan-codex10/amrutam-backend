"""Print the current TOTP for a local synthetic admin/doctor account."""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.app.security import demo_totp_secret, totp_counter

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("email", help="seeded admin/doctor email")
args = parser.parse_args()
email = args.email.strip().lower()
allowed = {"admin.demo@example.com", *(f"doctor{i:02d}.demo@example.com" for i in range(1, 6))}
if email not in allowed:
    raise SystemExit("Email is not one of the seeded privileged demo accounts")
print(totp_counter(demo_totp_secret(email), int(time.time() // 30)))
