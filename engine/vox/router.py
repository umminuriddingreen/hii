"""
Intent router — fluid, fast, adaptive.
Uses the best available Ollama model to understand intent and decide action.
Falls back gracefully. No rigid schemas — the LLM figures it out.
"""

import json
import urllib.request
import urllib.error
import subprocess

OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
ROUTER_TIMEOUT = 90

# Model preference order — tries fastest first
MODEL_PREFERENCE = ["gemma3:4b", "qwen3:8b", "gemma4:31b", "qwen3.6:35b"]

SYSTEM_PROMPT = """You are VOX, a voice-to-action engine. You receive spoken commands and decide what to do.

You have these powers:
1. Run shell commands (anything you'd type in terminal)
2. Open Mac apps
3. Ask Claude Code (hermes) for complex tasks — coding, reasoning, multi-step work
4. Queue tasks in HII engine for background processing
5. Run registered HII skills

Respond with JSON only:
{"action":"shell|app|hermes|hii_skill|hii_task","do":"the command or query","why":"brief reason"}

For shell: "do" = the exact shell command
For app: "do" = app name
For hermes: "do" = the full question/request for Claude
For hii_skill: "do" = skill_id
For hii_task: "do" = task description

Be practical. Most things are shell commands. If someone says "what time is it" → shell, "do": "date".
If someone says "write me a python script" → hermes. If they say "open spotify" → app."""


def _detect_model() -> str:
    """Find the fastest available model."""
    try:
        req = urllib.request.Request("http://localhost:11434/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            available = {m["name"] for m in data.get("models", [])}

        for model in MODEL_PREFERENCE:
            if model in available:
                return model

        # Return whatever's available (not embedding models)
        for m in data.get("models", []):
            if "embed" not in m["name"]:
                return m["name"]
    except Exception:
        pass
    return MODEL_PREFERENCE[0]


def _call_llm(model: str, user_msg: str) -> str:
    """Call Ollama chat API."""
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 600},
    }).encode()

    req = urllib.request.Request(
        OLLAMA_CHAT_URL, data=payload,
        headers={"Content-Type": "application/json"},
    )

    with urllib.request.urlopen(req, timeout=ROUTER_TIMEOUT) as resp:
        data = json.loads(resp.read())
        msg = data.get("message", {})
        content = msg.get("content", "")
        # Handle thinking models — content may be empty, thinking has the goods
        if not content.strip():
            content = msg.get("thinking", "")
        return content


def _parse_response(raw: str) -> dict:
    """Extract JSON from whatever the LLM returns."""
    s = raw
    # Strip thinking tags
    if "<think>" in s:
        s = s.split("</think>")[-1]
    # Strip markdown fences
    if "```json" in s:
        s = s.split("```json")[-1].split("```")[0]
    elif "```" in s:
        parts = s.split("```")
        if len(parts) >= 3:
            s = parts[1]
    s = s.strip()

    # Try to find JSON object
    start = s.find("{")
    end = s.rfind("}") + 1
    if start >= 0 and end > start:
        s = s[start:end]

    return json.loads(s)


def _to_route_result(parsed: dict) -> dict:
    """Normalize LLM output to internal route format."""
    action = parsed.get("action", "hermes")
    do = parsed.get("do", "")

    route_map = {
        "shell": "shell",
        "app": "app",
        "hermes": "hermes",
        "hii_skill": "hii_skill",
        "hii_task": "hii_task",
    }

    route = route_map.get(action, "hermes")

    return {
        "intent": do,
        "route": route,
        "confidence": 0.9,
        "skill_id": do if route == "hii_skill" else None,
        "command": do if route == "shell" else None,
        "app": do if route == "app" else None,
        "params": {},
        "reasoning": parsed.get("why", ""),
    }


def route(text: str) -> dict:
    """Route a voice command. LLM-first, keyword fallback."""
    try:
        model = _detect_model()
        raw = _call_llm(model, text)
        parsed = _parse_response(raw)
        result = _to_route_result(parsed)
        result["model"] = model
        return result
    except Exception as e:
        return _keyword_fallback(text, str(e))


def _keyword_fallback(text: str, reason: str = "") -> dict:
    """Last resort when LLM is unavailable."""
    t = text.lower().strip()

    phrases = {"what time": "date", "disk space": "df -h", "uptime": "uptime"}
    for phrase, cmd in phrases.items():
        if phrase in t:
            return {"intent": text, "route": "shell", "confidence": 0.7,
                    "command": cmd, "skill_id": None, "app": None,
                    "params": {}, "reasoning": f"keyword fallback ({reason})"}

    if any(t.startswith(w) for w in ["open ", "launch "]):
        words = t.split()
        app = words[1] if len(words) > 1 else ""
        return {"intent": text, "route": "app", "confidence": 0.6,
                "command": None, "skill_id": None, "app": app,
                "params": {}, "reasoning": f"keyword fallback ({reason})"}

    return {"intent": text, "route": "hermes", "confidence": 0.5,
            "command": None, "skill_id": None, "app": None,
            "params": {}, "reasoning": f"default to hermes ({reason})"}
