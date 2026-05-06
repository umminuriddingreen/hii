from __future__ import annotations

import os
import secrets
from http import cookies
from pathlib import Path

from .fsutil import atomic_write_text


HII_DIR = Path.home() / ".hii"
AUTH_TOKEN_FILE = HII_DIR / "auth_token"
AUTH_COOKIE_NAME = "hii_auth"


def get_auth_token() -> str:
    env_token = os.environ.get("HII_AUTH_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        token = AUTH_TOKEN_FILE.read_text().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    HII_DIR.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    atomic_write_text(AUTH_TOKEN_FILE, token + "\n")
    return token


def extract_auth_token(handler) -> str:
    header = handler.headers.get("Authorization", "").strip()
    if header.startswith("Bearer "):
        return header[7:].strip()
    raw_cookie = handler.headers.get("Cookie", "")
    if raw_cookie:
        jar = cookies.SimpleCookie()
        jar.load(raw_cookie)
        morsel = jar.get(AUTH_COOKIE_NAME)
        if morsel and morsel.value:
            return morsel.value
    return ""


def auth_cookie_header(token: str) -> str:
    return f"{AUTH_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict"
