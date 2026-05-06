"""
Psyche Learner — Extracts patterns from conversations and interactions.

This module watches chat logs, file activity, and user corrections,
then updates the psyche profile automatically.

Learning modes:
1. Chat analysis: extract traits, preferences, knowledge from conversations
2. Correction tracking: when user says "no" or redirects, update heuristics
3. Workflow observation: detect repeated action sequences
4. Knowledge extraction: map domains mentioned and depth of discussion

Uses Ollama for LOCAL pattern extraction (structured output only —
the local model fills in a JSON template, never reasons freely).
"""

import json
import re
from pathlib import Path
from datetime import datetime
from typing import Optional

from .profile import PsycheProfile

# Template the local model fills in — NO free-form reasoning
EXTRACTION_TEMPLATE = """{
  "traits": ["<list cognitive traits observed>"],
  "preferences": [{"context": "<when>", "preference": "<what they prefer>"}],
  "knowledge_domains": [{"domain": "<topic>", "depth": "surface|working|deep|expert"}],
  "corrections": ["<things the user corrected or rejected>"],
  "values_expressed": ["<core values evident in the text>"]
}"""

EXTRACTION_PROMPT = f"""You are a data extractor. Given a conversation excerpt, fill in ONLY the JSON template below. Do not add commentary. Do not reason. Just extract and fill.

Template:
{EXTRACTION_TEMPLATE}

Conversation:
{{conversation}}

Output the filled JSON only:"""


async def extract_from_chat(conversation: str, ollama_fn, model: str = "qwen3.5:35b") -> dict:
    """
    Send conversation to local model with structured extraction prompt.
    Local model ONLY fills a template — no reasoning allowed.
    """
    prompt = EXTRACTION_PROMPT.replace("{{conversation}}", conversation[:3000])

    try:
        result = await ollama_fn(model, [
            {"role": "system", "content": "You are a JSON data extractor. Output valid JSON only. No text before or after."},
            {"role": "user", "content": prompt},
        ], {"temperature": 0})

        text = result.get("text", result) if isinstance(result, dict) else str(result)
        # Extract JSON from response
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            return json.loads(match.group())
    except Exception:
        pass
    return {}


def apply_extraction(profile: PsycheProfile, extracted: dict, source: str = "chat_learner"):
    """Apply extracted data to the psyche profile."""
    for trait in extracted.get("traits", []):
        if isinstance(trait, str) and trait.strip():
            profile.add_cognitive(trait.strip(), 0.6, f"extracted from {source}")

    for pref in extracted.get("preferences", []):
        if isinstance(pref, dict):
            profile.add_decision(
                pref.get("context", "general"),
                pref.get("preference", ""),
                0.6,
                source,
            )

    for kd in extracted.get("knowledge_domains", []):
        if isinstance(kd, dict):
            profile.add_knowledge(
                kd.get("domain", "unknown"),
                kd.get("depth", "surface"),
            )

    for val in extracted.get("values_expressed", []):
        if isinstance(val, str) and val.strip() and val.strip() not in profile.values:
            profile.values.append(val.strip())
            profile.values = profile.values[:20]  # cap

    for correction in extracted.get("corrections", []):
        if isinstance(correction, str) and correction.strip():
            profile.observe("correction", correction.strip(), source)

    profile.save()


def learn_from_obsidian_vault(vault_path: str, profile: PsycheProfile, max_files: int = 50):
    """
    Scan recent Obsidian chat logs and extract patterns.
    This is a batch operation — run periodically, not on every chat.
    """
    vault = Path(vault_path)
    chats_dir = vault / "Chats"
    if not chats_dir.exists():
        return

    # Get most recent chat files
    files = sorted(chats_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)[:max_files]

    conversations = []
    for f in files:
        text = f.read_text()
        if len(text) > 100:  # skip trivial entries
            conversations.append(text[:2000])  # cap per file

    return conversations  # caller runs extraction async


def detect_corrections(text: str) -> list[str]:
    """
    Simple heuristic: detect correction patterns in user text.
    No ML needed — just regex for common correction phrases.
    """
    patterns = [
        r"(?:no|nope|wrong|don'?t|stop|not that|instead)\s+(.{10,80})",
        r"(?:actually|correction|I meant)\s+(.{10,80})",
        r"(?:prefer|rather|better to)\s+(.{10,80})",
    ]
    corrections = []
    for pat in patterns:
        for match in re.finditer(pat, text, re.IGNORECASE):
            corrections.append(match.group(0).strip())
    return corrections[:5]
