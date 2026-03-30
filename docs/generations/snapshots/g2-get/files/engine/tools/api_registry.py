#!/usr/bin/env python3
"""
HII API Registry — Natural language API discovery and management.

Usage:
    python3 -m engine.tools.api_registry search <query>
    python3 -m engine.tools.api_registry add <name_or_query>
    python3 -m engine.tools.api_registry list
    python3 -m engine.tools.api_registry info <name>
    python3 -m engine.tools.api_registry remove <name>
    python3 -m engine.tools.api_registry discover <natural_language_query>
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import List, Dict, Optional, Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REGISTRY_DIR = Path.home() / ".hii"
REGISTRY_FILE = REGISTRY_DIR / "api_registry.json"

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class CatalogEntry:
    name: str
    description: str
    category: str
    auth_type: str          # apiKey | oauth2 | none
    base_url: str
    docs_url: str
    free_tier: bool
    keywords: List[str] = field(default_factory=list)


@dataclass
class InstalledAPI:
    name: str
    description: str
    base_url: str
    auth_type: str
    token_name: str         # vault key
    category: str
    installed_at: str
    status: str = "active"  # active | inactive
    config: Dict[str, Any] = field(default_factory=dict)

# ---------------------------------------------------------------------------
# Built-in catalog (~45 APIs)
# ---------------------------------------------------------------------------

CATALOG: List[CatalogEntry] = [
    CatalogEntry("google-calendar", "Google Calendar — create, read, update events and schedules",
                 "productivity", "oauth2", "https://www.googleapis.com/calendar/v3",
                 "https://developers.google.com/calendar", True,
                 ["calendar", "schedule", "events", "meetings", "google"]),
    CatalogEntry("google-drive", "Google Drive — file storage, sharing, collaboration",
                 "storage", "oauth2", "https://www.googleapis.com/drive/v3",
                 "https://developers.google.com/drive", True,
                 ["drive", "files", "storage", "google", "documents"]),
    CatalogEntry("google-sheets", "Google Sheets — spreadsheet data read/write",
                 "productivity", "oauth2", "https://sheets.googleapis.com/v4",
                 "https://developers.google.com/sheets", True,
                 ["sheets", "spreadsheet", "data", "google", "tables"]),
    CatalogEntry("gmail", "Gmail — send, read, manage email",
                 "productivity", "oauth2", "https://gmail.googleapis.com",
                 "https://developers.google.com/gmail", True,
                 ["email", "mail", "gmail", "google", "messages"]),
    CatalogEntry("notion", "Notion — workspace, databases, pages, knowledge management",
                 "productivity", "oauth2", "https://api.notion.com/v1",
                 "https://developers.notion.com", True,
                 ["notion", "wiki", "notes", "database", "workspace", "knowledge"]),
    CatalogEntry("slack", "Slack — team messaging, channels, notifications, bots",
                 "social", "oauth2", "https://slack.com/api",
                 "https://api.slack.com", True,
                 ["slack", "chat", "messaging", "notifications", "team"]),
    CatalogEntry("discord", "Discord — servers, channels, bots, messaging",
                 "social", "apiKey", "https://discord.com/api/v10",
                 "https://discord.com/developers/docs", True,
                 ["discord", "chat", "gaming", "community", "bot"]),
    CatalogEntry("github", "GitHub — repos, issues, PRs, actions, code hosting",
                 "dev-tools", "apiKey", "https://api.github.com",
                 "https://docs.github.com/en/rest", True,
                 ["github", "git", "code", "repos", "issues", "pr"]),
    CatalogEntry("figma", "Figma — design files, components, prototypes",
                 "design", "apiKey", "https://api.figma.com/v1",
                 "https://www.figma.com/developers", True,
                 ["figma", "design", "ui", "prototype", "mockup"]),
    CatalogEntry("spotify", "Spotify — music playback, playlists, search, recommendations",
                 "music", "oauth2", "https://api.spotify.com/v1",
                 "https://developer.spotify.com/documentation/web-api", True,
                 ["spotify", "music", "playlists", "songs", "audio", "streaming"]),
    CatalogEntry("openai", "OpenAI — GPT, DALL-E, Whisper, embeddings",
                 "ai", "apiKey", "https://api.openai.com/v1",
                 "https://platform.openai.com/docs", False,
                 ["openai", "gpt", "chatgpt", "ai", "llm", "dalle", "whisper"]),
    CatalogEntry("anthropic", "Anthropic — Claude models, AI completions",
                 "ai", "apiKey", "https://api.anthropic.com/v1",
                 "https://docs.anthropic.com", False,
                 ["anthropic", "claude", "ai", "llm"]),
    CatalogEntry("cloudflare-r2", "Cloudflare R2 — S3-compatible object storage, zero egress fees",
                 "storage", "apiKey", "https://api.cloudflare.com/client/v4",
                 "https://developers.cloudflare.com/r2", True,
                 ["cloudflare", "r2", "storage", "s3", "objects", "cdn"]),
    CatalogEntry("aws-s3", "AWS S3 — scalable object storage",
                 "storage", "apiKey", "https://s3.amazonaws.com",
                 "https://docs.aws.amazon.com/s3", True,
                 ["aws", "s3", "storage", "objects", "bucket", "amazon"]),
    CatalogEntry("twilio", "Twilio — SMS, voice calls, WhatsApp messaging",
                 "social", "apiKey", "https://api.twilio.com/2010-04-01",
                 "https://www.twilio.com/docs", True,
                 ["twilio", "sms", "text", "voice", "phone", "whatsapp"]),
    CatalogEntry("sendgrid", "SendGrid — transactional and marketing email",
                 "social", "apiKey", "https://api.sendgrid.com/v3",
                 "https://docs.sendgrid.com", True,
                 ["sendgrid", "email", "mail", "transactional"]),
    CatalogEntry("stripe", "Stripe — payments, subscriptions, billing",
                 "finance", "apiKey", "https://api.stripe.com/v1",
                 "https://stripe.com/docs/api", True,
                 ["stripe", "payments", "billing", "subscriptions", "money"]),
    CatalogEntry("canvas-lms", "Canvas LMS — courses, assignments, grades, submissions",
                 "education", "apiKey", "https://canvas.instructure.com/api/v1",
                 "https://canvas.instructure.com/doc/api", True,
                 ["canvas", "lms", "courses", "grades", "assignments", "education", "school"]),
    CatalogEntry("linear", "Linear — issue tracking, project management, sprints",
                 "dev-tools", "apiKey", "https://api.linear.app",
                 "https://developers.linear.app", True,
                 ["linear", "issues", "project", "tracking", "sprints"]),
    CatalogEntry("vercel", "Vercel — deploy, serverless functions, edge",
                 "dev-tools", "apiKey", "https://api.vercel.com",
                 "https://vercel.com/docs/rest-api", True,
                 ["vercel", "deploy", "hosting", "serverless", "frontend"]),
    CatalogEntry("netlify", "Netlify — deploy, forms, functions, edge",
                 "dev-tools", "apiKey", "https://api.netlify.com/api/v1",
                 "https://docs.netlify.com", True,
                 ["netlify", "deploy", "hosting", "static", "frontend"]),
    CatalogEntry("firebase", "Firebase — auth, firestore, storage, hosting, functions",
                 "dev-tools", "apiKey", "https://firebase.googleapis.com",
                 "https://firebase.google.com/docs", True,
                 ["firebase", "google", "auth", "database", "hosting", "realtime"]),
    CatalogEntry("supabase", "Supabase — Postgres, auth, storage, realtime, edge functions",
                 "dev-tools", "apiKey", "https://api.supabase.com",
                 "https://supabase.com/docs", True,
                 ["supabase", "postgres", "database", "auth", "storage", "realtime"]),
    CatalogEntry("mongodb-atlas", "MongoDB Atlas — managed MongoDB, search, vector",
                 "dev-tools", "apiKey", "https://cloud.mongodb.com/api/atlas/v2",
                 "https://www.mongodb.com/docs/atlas", True,
                 ["mongodb", "mongo", "database", "nosql", "atlas"]),
    CatalogEntry("redis-cloud", "Redis Cloud — managed Redis, caching, pub/sub",
                 "dev-tools", "apiKey", "https://api.redislabs.com/v1",
                 "https://docs.redis.com/latest/rc", True,
                 ["redis", "cache", "pubsub", "database", "memory"]),
    CatalogEntry("pinecone", "Pinecone — vector database for embeddings and search",
                 "ai", "apiKey", "https://api.pinecone.io",
                 "https://docs.pinecone.io", True,
                 ["pinecone", "vector", "embeddings", "search", "ai", "similarity"]),
    CatalogEntry("weaviate", "Weaviate — vector search engine, semantic search",
                 "ai", "apiKey", "https://api.weaviate.io",
                 "https://weaviate.io/developers/weaviate", True,
                 ["weaviate", "vector", "search", "semantic", "ai"]),
    CatalogEntry("huggingface", "HuggingFace — models, datasets, inference API",
                 "ai", "apiKey", "https://api-inference.huggingface.co",
                 "https://huggingface.co/docs/api-inference", True,
                 ["huggingface", "models", "ml", "ai", "inference", "transformers"]),
    CatalogEntry("replicate", "Replicate — run ML models in the cloud",
                 "ai", "apiKey", "https://api.replicate.com/v1",
                 "https://replicate.com/docs", False,
                 ["replicate", "ml", "models", "ai", "inference"]),
    CatalogEntry("stability-ai", "Stability AI — Stable Diffusion, image generation",
                 "ai", "apiKey", "https://api.stability.ai/v1",
                 "https://platform.stability.ai/docs", False,
                 ["stability", "stable-diffusion", "image", "generation", "ai", "art"]),
    CatalogEntry("elevenlabs", "ElevenLabs — text-to-speech, voice cloning",
                 "ai", "apiKey", "https://api.elevenlabs.io/v1",
                 "https://docs.elevenlabs.io", True,
                 ["elevenlabs", "tts", "voice", "speech", "audio", "clone"]),
    CatalogEntry("assemblyai", "AssemblyAI — speech-to-text, transcription, audio intelligence",
                 "ai", "apiKey", "https://api.assemblyai.com/v2",
                 "https://www.assemblyai.com/docs", True,
                 ["assemblyai", "stt", "transcription", "speech", "audio"]),
    CatalogEntry("mapbox", "Mapbox — maps, geocoding, directions, navigation",
                 "dev-tools", "apiKey", "https://api.mapbox.com",
                 "https://docs.mapbox.com", True,
                 ["mapbox", "maps", "geo", "location", "directions", "navigation"]),
    CatalogEntry("openweather", "OpenWeather — weather data, forecasts, alerts",
                 "weather", "apiKey", "https://api.openweathermap.org/data/2.5",
                 "https://openweathermap.org/api", True,
                 ["weather", "forecast", "temperature", "climate"]),
    CatalogEntry("newsapi", "NewsAPI — headlines, articles, news search",
                 "productivity", "apiKey", "https://newsapi.org/v2",
                 "https://newsapi.org/docs", True,
                 ["news", "headlines", "articles", "media"]),
    CatalogEntry("youtube-data", "YouTube Data API — videos, channels, playlists, search",
                 "social", "apiKey", "https://www.googleapis.com/youtube/v3",
                 "https://developers.google.com/youtube/v3", True,
                 ["youtube", "video", "streaming", "google"]),
    CatalogEntry("twitter-x", "Twitter/X API — tweets, timelines, search",
                 "social", "oauth2", "https://api.twitter.com/2",
                 "https://developer.twitter.com/en/docs", True,
                 ["twitter", "x", "tweets", "social", "timeline"]),
    CatalogEntry("instagram-graph", "Instagram Graph API — media, insights, publishing",
                 "social", "oauth2", "https://graph.instagram.com",
                 "https://developers.facebook.com/docs/instagram-api", True,
                 ["instagram", "photos", "social", "media", "images"]),
    CatalogEntry("todoist", "Todoist — tasks, projects, labels, productivity",
                 "productivity", "apiKey", "https://api.todoist.com/rest/v2",
                 "https://developer.todoist.com/rest/v2", True,
                 ["todoist", "tasks", "todo", "productivity", "projects"]),
    CatalogEntry("airtable", "Airtable — spreadsheet-database hybrid, automations",
                 "productivity", "apiKey", "https://api.airtable.com/v0",
                 "https://airtable.com/developers/web/api", True,
                 ["airtable", "database", "spreadsheet", "tables", "records"]),
    CatalogEntry("dropbox", "Dropbox — file storage, sharing, sync",
                 "storage", "oauth2", "https://api.dropboxapi.com/2",
                 "https://www.dropbox.com/developers", True,
                 ["dropbox", "files", "storage", "sync", "sharing"]),
    CatalogEntry("onedrive", "OneDrive — Microsoft cloud file storage",
                 "storage", "oauth2", "https://graph.microsoft.com/v1.0/me/drive",
                 "https://learn.microsoft.com/en-us/onedrive/developer", True,
                 ["onedrive", "microsoft", "files", "storage", "office"]),
    CatalogEntry("zoom", "Zoom — meetings, webinars, video conferencing",
                 "productivity", "oauth2", "https://api.zoom.us/v2",
                 "https://developers.zoom.us/docs", True,
                 ["zoom", "meetings", "video", "conferencing", "webinar"]),
    CatalogEntry("comfyui", "ComfyUI — node-based Stable Diffusion workflow engine",
                 "ai", "none", "http://127.0.0.1:8188/api",
                 "https://github.com/comfyanonymous/ComfyUI", True,
                 ["comfyui", "diffusion", "image", "workflow", "local", "ai"]),
    CatalogEntry("midjourney", "Midjourney (unofficial) — AI image generation via Discord",
                 "ai", "apiKey", "https://api.mymidjourney.ai/api/v1",
                 "https://docs.midjourney.com", False,
                 ["midjourney", "image", "generation", "ai", "art"]),
    CatalogEntry("runwayml", "RunwayML — AI video generation, motion brush",
                 "ai", "apiKey", "https://api.dev.runwayml.com/v1",
                 "https://docs.dev.runwayml.com", False,
                 ["runway", "video", "generation", "ai", "motion"]),
]

CATALOG_BY_NAME: Dict[str, CatalogEntry] = {e.name: e for e in CATALOG}

# ---------------------------------------------------------------------------
# Registry persistence
# ---------------------------------------------------------------------------

def _load_registry() -> Dict[str, dict]:
    if REGISTRY_FILE.exists():
        try:
            return json.loads(REGISTRY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_registry(data: Dict[str, dict]) -> None:
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.write_text(json.dumps(data, indent=2))

# ---------------------------------------------------------------------------
# Fuzzy / keyword matching
# ---------------------------------------------------------------------------

_STOP_WORDS = {
    "i", "me", "my", "need", "want", "to", "a", "an", "the", "with", "for",
    "and", "or", "that", "this", "it", "is", "are", "was", "be", "do", "of",
    "in", "on", "can", "get", "use", "add", "find", "search", "when", "how",
    "some", "any", "all", "from", "into", "have", "has",
}


def _extract_keywords(text: str) -> List[str]:
    tokens = text.lower().replace('"', '').replace("'", "").split()
    return [t for t in tokens if t not in _STOP_WORDS and len(t) > 1]


def _score_entry(entry: CatalogEntry, keywords: List[str]) -> float:
    score = 0.0
    haystack = (entry.name + " " + entry.description + " " + entry.category +
                " " + " ".join(entry.keywords)).lower()
    for kw in keywords:
        # exact keyword match in keywords list
        if kw in entry.keywords:
            score += 3.0
        # exact substring in name
        if kw in entry.name:
            score += 2.5
        # exact substring in category
        if kw == entry.category:
            score += 2.0
        # substring in description
        if kw in entry.description.lower():
            score += 1.5
        # fuzzy
        best = max(
            SequenceMatcher(None, kw, w).ratio()
            for w in haystack.split()
        )
        if best > 0.7:
            score += best
    return score


def search_catalog(query: str, limit: int = 10) -> List[tuple]:
    """Return list of (score, CatalogEntry) sorted descending."""
    keywords = _extract_keywords(query)
    if not keywords:
        return []
    results = []
    for entry in CATALOG:
        s = _score_entry(entry, keywords)
        if s > 0.5:
            results.append((round(s, 2), entry))
    results.sort(key=lambda x: x[0], reverse=True)
    return results[:limit]

# ---------------------------------------------------------------------------
# Web search fallback
# ---------------------------------------------------------------------------

def _web_search(query: str) -> List[dict]:
    """Query public API directory. Returns list of dicts or empty on failure."""
    try:
        url = "https://api.publicapis.org/entries?" + urllib.parse.urlencode({"title": query})
        req = urllib.request.Request(url, headers={"User-Agent": "HII/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get("entries") or []
    except Exception:
        return []

# ---------------------------------------------------------------------------
# Core operations
# ---------------------------------------------------------------------------

def discover(query: str) -> None:
    """Natural language discovery — catalog + web fallback."""
    results = search_catalog(query)
    if results:
        _print_header("Catalog matches")
        for score, e in results:
            _print_entry_short(e, score)
    else:
        print("  No catalog matches.")

    # web fallback
    keywords = _extract_keywords(query)
    if keywords:
        web = _web_search(keywords[0])
        if web:
            _print_header("Web results (publicapis.org)")
            for item in web[:5]:
                print(f"  {item.get('API', '?'):30s}  {item.get('Description', '')[:60]}")
                print(f"  {'':30s}  cat={item.get('Category','')}  auth={item.get('Auth','none')}  https={item.get('HTTPS','')}")
                print()


def search(query: str) -> None:
    results = search_catalog(query)
    if not results:
        print("No matches. Try `discover` for web search fallback.")
        return
    _print_header(f"Search results for '{query}'")
    for score, e in results:
        _print_entry_short(e, score)


def add_api(name_or_query: str) -> None:
    registry = install_api(name_or_query, interactive=True)
    print(f"\n  Added '{registry['name']}' to registry.")


def install_api(name_or_query: str, interactive: bool = False) -> dict:
    registry = _load_registry()

    entry = CATALOG_BY_NAME.get(name_or_query)
    if not entry:
        results = search_catalog(name_or_query, limit=5)
        if not results:
            raise ValueError(f"No API found matching '{name_or_query}'.")
        if len(results) == 1 or (len(results) > 1 and results[0][0] > results[1][0] + 2):
            entry = results[0][1]
        elif interactive:
            print("Multiple matches found:")
            for i, (sc, e) in enumerate(results):
                print(f"  [{i+1}] {e.name:25s} ({e.category})  score={sc}")
            try:
                choice = int(input("Pick a number: ")) - 1
                entry = results[choice][1]
            except (ValueError, IndexError, EOFError):
                raise ValueError("Cancelled.")
        else:
            names = ", ".join(e.name for _, e in results[:3])
            raise ValueError(f"Multiple APIs match '{name_or_query}': {names}")

    if entry.name in registry:
        return registry[entry.name]

    token_name = ""
    if entry.auth_type != "none":
        token_name = f"{entry.name}_token"
        if interactive:
            print(f"\n  {entry.name} requires {entry.auth_type} auth.")
            try:
                token_val = input(f"  Enter API token/key (or press Enter to skip): ").strip()
            except EOFError:
                token_val = ""
            if token_val:
                try:
                    from engine.core.vault import store_secret
                    store_secret(token_name, token_val)
                    print(f"  Token stored in vault as '{token_name}'.")
                except Exception:
                    print(f"  (vault unavailable — remember to store token as '{token_name}')")
            else:
                print(f"  Skipped. Store your token later in vault as '{token_name}'.")

    installed = InstalledAPI(
        name=entry.name,
        description=entry.description,
        base_url=entry.base_url,
        auth_type=entry.auth_type,
        token_name=token_name,
        category=entry.category,
        installed_at=datetime.now(timezone.utc).isoformat(),
        status="active",
        config={},
    )
    record = asdict(installed)
    registry[entry.name] = record
    _save_registry(registry)
    return record


def list_apis() -> None:
    registry = _load_registry()
    if not registry:
        print("No APIs installed. Use `add` or `discover` to get started.")
        return
    _print_header("Installed APIs")
    for name, data in registry.items():
        status_icon = "+" if data.get("status") == "active" else "-"
        print(f"  [{status_icon}] {name:25s}  {data.get('category',''):14s}  {data.get('auth_type','')}")
    print(f"\n  Total: {len(registry)}")


def info(name: str) -> None:
    registry = _load_registry()
    data = registry.get(name)
    if data:
        _print_header(f"Installed: {name}")
        for k, v in data.items():
            print(f"  {k:18s}: {v}")
        return
    entry = CATALOG_BY_NAME.get(name)
    if entry:
        _print_header(f"Catalog: {name}")
        print(f"  {'description':18s}: {entry.description}")
        print(f"  {'category':18s}: {entry.category}")
        print(f"  {'auth_type':18s}: {entry.auth_type}")
        print(f"  {'base_url':18s}: {entry.base_url}")
        print(f"  {'docs_url':18s}: {entry.docs_url}")
        print(f"  {'free_tier':18s}: {entry.free_tier}")
        print(f"  {'status':18s}: not installed")
        return
    print(f"No API named '{name}' found in registry or catalog.")


def remove(name: str) -> None:
    registry = _load_registry()
    if name not in registry:
        print(f"'{name}' is not installed.")
        return
    del registry[name]
    _save_registry(registry)
    print(f"Removed '{name}' from registry.")

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _print_header(title: str) -> None:
    print(f"\n  === {title} ===\n")


def _print_entry_short(e: CatalogEntry, score: float) -> None:
    free = "free" if e.free_tier else "paid"
    print(f"  {e.name:25s}  score={score:<6}  [{e.category}] [{e.auth_type}] [{free}]")
    print(f"  {'':25s}  {e.description}")
    print()

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="hii-api",
        description="HII API Registry — discover and manage APIs with natural language",
    )
    sub = parser.add_subparsers(dest="command")

    p_search = sub.add_parser("search", help="Search catalog by keyword or phrase")
    p_search.add_argument("query", nargs="+")

    p_add = sub.add_parser("add", help="Add an API to the registry")
    p_add.add_argument("name_or_query", nargs="+")

    p_list = sub.add_parser("list", help="List installed APIs")

    p_info = sub.add_parser("info", help="Show details for an API")
    p_info.add_argument("name")

    p_remove = sub.add_parser("remove", help="Remove an API from the registry")
    p_remove.add_argument("name")

    p_discover = sub.add_parser("discover", help="Natural language discovery (catalog + web)")
    p_discover.add_argument("query", nargs="+")

    args = parser.parse_args()

    if args.command == "search":
        search(" ".join(args.query))
    elif args.command == "add":
        add_api(" ".join(args.name_or_query))
    elif args.command == "list":
        list_apis()
    elif args.command == "info":
        info(args.name)
    elif args.command == "remove":
        remove(args.name)
    elif args.command == "discover":
        discover(" ".join(args.query))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
