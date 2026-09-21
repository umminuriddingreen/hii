#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-BSL-1.1

from __future__ import annotations

import glob
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile


def normalize_phone(value: str) -> str | None:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 10:
        digits = "1" + digits
    if not 8 <= len(digits) <= 15:
        return None
    return "+" + digits


parser = argparse.ArgumentParser(description="Seal the Contacts My Card phone into a SatelliteBridge.app bundle.")
parser.add_argument("--app", required=True, type=Path)
arguments = parser.parse_args()

home = Path.home()
database_paths = [home / "Library/Application Support/AddressBook/AddressBook-v22.abcddb"]
database_paths.extend(
    Path(path)
    for path in glob.glob(
        str(home / "Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb")
    )
)

phones: set[str] = set()
query = """
SELECT p.ZFULLNUMBER
FROM ZABCDPHONENUMBER p
JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK OR p.Z22_OWNER = r.Z_PK
WHERE r.ZME IS NOT NULL
   OR r.Z22_ME IS NOT NULL
   OR r.ZCONTAINERWHERECONTACTISME IS NOT NULL
"""
for database_path in database_paths:
    if not database_path.exists():
        continue
    try:
        connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
        for (raw_phone,) in connection.execute(query):
            if normalized := normalize_phone(raw_phone):
                phones.add(normalized)
    except sqlite3.Error:
        continue

if len(phones) != 1:
    raise SystemExit(
        f"pairing refused: expected exactly one phone on the Contacts My Card, found {len(phones)}"
    )

phone = next(iter(phones))
app = arguments.app.expanduser().resolve()
resources = app / "Contents/Resources"
info_plist = app / "Contents/Info.plist"
if not info_plist.is_file() or not resources.is_dir():
    raise SystemExit("pairing refused: --app is not a built SatelliteBridge.app bundle")
payload = json.dumps({"schema_version": 1, "phone": phone}, separators=(",", ":")) + "\n"

descriptor, temporary_name = tempfile.mkstemp(prefix="owner-", suffix=".json", dir=resources)
try:
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_name, resources / "owner.json")
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)

subprocess.run(
    ["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(app)],
    check=True,
    stdout=subprocess.DEVNULL,
)
print("paired=true")
print("account=owner")
print("identity_storage=signed-app-bundle")
