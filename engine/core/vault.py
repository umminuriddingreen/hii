#!/usr/bin/env python3
"""
HII Vault — Token/Secret Security Layer

Stores API tokens and keys as Fernet-encrypted values in ~/.hii/vault.json.
Master key derived from passphrase via PBKDF2.

Usage:
    python3 -m engine.core.vault store <name> <value> [--service svc] [--expires YYYY-MM-DD]
    python3 -m engine.core.vault get <name>
    python3 -m engine.core.vault list
    python3 -m engine.core.vault revoke <name>
    python3 -m engine.core.vault rotate <name> <new_value>
    python3 -m engine.core.vault migrate-env
"""

import base64
import getpass
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from cryptography.fernet import Fernet

VAULT_DIR = Path.home() / ".hii"
VAULT_FILE = VAULT_DIR / "vault.json"
SALT_FILE = VAULT_DIR / "vault.salt"


def _get_passphrase(confirm: bool = False) -> str:
    """Get master passphrase from env or interactive prompt."""
    pp = os.environ.get("HII_VAULT_PASS")
    if pp:
        return pp
    pp = getpass.getpass("HII Vault master passphrase: ")
    if confirm:
        pp2 = getpass.getpass("Confirm passphrase: ")
        if pp != pp2:
            print("error: passphrases do not match", file=sys.stderr)
            sys.exit(1)
    return pp


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    """Derive a 32-byte Fernet key from passphrase + salt via PBKDF2."""
    raw = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 480_000, dklen=32)
    return base64.urlsafe_b64encode(raw)


def _load_or_create_salt(confirm_new: bool = True) -> bytes:
    """Load existing salt or create a new one on first use."""
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    if SALT_FILE.exists():
        return SALT_FILE.read_bytes()
    salt = os.urandom(16)
    SALT_FILE.write_bytes(salt)
    SALT_FILE.chmod(0o600)
    return salt


def _get_fernet(confirm_new: bool = False) -> Fernet:
    """Build a Fernet instance from the master passphrase."""
    first_time = not SALT_FILE.exists()
    salt = _load_or_create_salt()
    passphrase = _get_passphrase(confirm=first_time or confirm_new)
    key = _derive_key(passphrase, salt)
    return Fernet(key)


def _load_vault() -> dict:
    """Load vault data from disk."""
    if not VAULT_FILE.exists():
        return {}
    try:
        return json.loads(VAULT_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save_vault(data: dict) -> None:
    """Save vault data to disk with restricted permissions."""
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    VAULT_FILE.write_text(json.dumps(data, indent=2))
    VAULT_FILE.chmod(0o600)


# ── Public API ────────────────────────────────────────────────

def store_secret(name: str, value: str, service: str = "", expires: str = "") -> None:
    f = _get_fernet()
    vault = _load_vault()
    encrypted = f.encrypt(value.encode()).decode()
    vault[name] = {
        "encrypted_value": encrypted,
        "service": service,
        "created_at": datetime.now(datetime.timezone.utc).isoformat(),
        "expires_at": expires or "",
    }
    _save_vault(vault)
    print(f"stored: {name}" + (f" (service={service})" if service else ""))


def get_secret(name: str) -> str:
    """Decrypt and return a secret by name."""
    vault = _load_vault()
    if name not in vault:
        print(f"error: '{name}' not found in vault", file=sys.stderr)
        sys.exit(1)
    entry = vault[name]
    # Check expiration
    if entry.get("expires_at"):
        try:
            exp = datetime.fromisoformat(entry["expires_at"])
            if datetime.utcnow() > exp:
                print(f"warning: '{name}' expired on {entry['expires_at']}", file=sys.stderr)
        except ValueError:
            pass
    f = _get_fernet()
    try:
        decrypted = f.decrypt(entry["encrypted_value"].encode()).decode()
    except Exception:
        print("error: decryption failed — wrong passphrase?", file=sys.stderr)
        sys.exit(1)
    return decrypted


def list_secrets() -> None:
    vault = _load_vault()
    if not vault:
        print("vault is empty")
        return
    print(f"{'NAME':<30} {'SERVICE':<15} {'CREATED':<20} {'EXPIRES':<12}")
    print("-" * 77)
    for name, entry in vault.items():
        svc = entry.get("service", "")
        created = entry.get("created_at", "")[:10]
        expires = entry.get("expires_at", "")[:10] or "-"
        print(f"{name:<30} {svc:<15} {created:<20} {expires:<12}")


def revoke_secret(name: str) -> None:
    vault = _load_vault()
    if name not in vault:
        print(f"error: '{name}' not found", file=sys.stderr)
        sys.exit(1)
    del vault[name]
    _save_vault(vault)
    print(f"revoked: {name}")


def rotate_secret(name: str, new_value: str) -> None:
    vault = _load_vault()
    if name not in vault:
        print(f"error: '{name}' not found", file=sys.stderr)
        sys.exit(1)
    entry = vault[name]
    f = _get_fernet()
    entry["encrypted_value"] = f.encrypt(new_value.encode()).decode()
    entry["created_at"] = datetime.now(datetime.timezone.utc).isoformat()
    vault[name] = entry
    _save_vault(vault)
    print(f"rotated: {name}")


def migrate_env() -> None:
    """Migrate CANVAS_TOKEN from ~/.hii/.env into the vault."""
    env_file = VAULT_DIR / ".env"
    if not env_file.exists():
        print("no .env file found at ~/.hii/.env")
        return
    token = ""
    for line in env_file.read_text().splitlines():
        if line.startswith("CANVAS_TOKEN="):
            token = line.split("=", 1)[1].strip()
    if not token:
        print("CANVAS_TOKEN not found in .env")
        return
    store_secret("CANVAS_TOKEN", token, service="canvas")
    print("migrated CANVAS_TOKEN from .env into vault")


def get_secret_quiet(name: str, passphrase: str = "") -> str | None:
    """Non-interactive secret retrieval for programmatic use.

    Returns None if vault isn't set up or secret doesn't exist.
    Requires HII_VAULT_PASS env var or explicit passphrase.
    """
    if not VAULT_FILE.exists() or not SALT_FILE.exists():
        return None
    vault = _load_vault()
    if name not in vault:
        return None
    pp = passphrase or os.environ.get("HII_VAULT_PASS", "")
    if not pp:
        return None
    salt = SALT_FILE.read_bytes()
    key = _derive_key(pp, salt)
    try:
        f = Fernet(key)
        return f.decrypt(vault[name]["encrypted_value"].encode()).decode()
    except Exception:
        return None


# ── CLI ───────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__.strip())
        sys.exit(0)

    cmd = args[0]

    if cmd == "store" and len(args) >= 3:
        name, value = args[1], args[2]
        service = ""
        expires = ""
        i = 3
        while i < len(args):
            if args[i] == "--service" and i + 1 < len(args):
                service = args[i + 1]; i += 2
            elif args[i] == "--expires" and i + 1 < len(args):
                expires = args[i + 1]; i += 2
            else:
                i += 1
        store_secret(name, value, service=service, expires=expires)

    elif cmd == "get" and len(args) >= 2:
        print(get_secret(args[1]))

    elif cmd == "list":
        list_secrets()

    elif cmd == "revoke" and len(args) >= 2:
        revoke_secret(args[1])

    elif cmd == "rotate" and len(args) >= 3:
        rotate_secret(args[1], args[2])

    elif cmd == "migrate-env":
        migrate_env()

    else:
        print(__doc__.strip())
        sys.exit(1)


if __name__ == "__main__":
    main()
