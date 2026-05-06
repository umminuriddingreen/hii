"""Intent orchestrator — classifies intent, runs tool loops, returns results."""

from __future__ import annotations
import re
import json
from dataclasses import dataclass, field
from datetime import datetime

from .config import Config
from .llm import get_client, ChatMessage
from . import memory
from .skills import registry as skills_registry
from .tools import web, shell, academic

TOOL_CALL_RE = re.compile(r"<tool_call>\s*([\s\S]*?)\s*</tool_call>", re.IGNORECASE)
TOOL_MAX_STEPS = 5

GROUND_RE = re.compile(
    r"\b(latest|recent|today|current|news|price|stock|score|ceo|president|"
    r"release date|version|status|what happened|who is|weather|when is)\b", re.IGNORECASE,
)
REFUSE_RE = re.compile(r"\b(refuse|bypass|steal|hack|malware|credential|phish)\b", re.IGNORECASE)


@dataclass
class OrchestratorResult:
    text: str
    messages: list[ChatMessage]
    used_tools: list[str]
    intent: str


def _system_prompt(cfg: Config, interactive: bool = False) -> str:
    mode = (
        "You are HII, a high-speed thought sharpening CLI and deterministic execution layer."
        if interactive else "You are HII, a concise local execution CLI."
    )
    return "\n".join([
        mode,
        "Operate as an execution system, not a chat companion.",
        "Be direct. Prefer short, high-signal answers.",
        "When a tool is needed, respond with only a single XML block:",
        '<tool_call>{"name":"web_search","query":"..."}</tool_call>',
        "Core tools: web_search, rag_search, shell, academic_search.",
        "If no tool is needed, answer normally.",
        f"Shell enabled: {cfg.allow_shell}. Search enabled: {cfg.allow_search}. Offline: {cfg.offline}.",
    ])


def classify_intent(prompt: str, cfg: Config) -> str:
    text = prompt.strip().lower()
    if not text:
        return "clarify"
    if REFUSE_RE.search(text):
        return "refuse"
    if cfg.allow_search and not cfg.offline and GROUND_RE.search(prompt):
        return "ground"
    if re.search(r"\b(plan|roadmap|strategy|architecture|design)\b", text):
        return "plan"
    if len(text.split()) <= 2:
        return "clarify"
    return "execute"


def _truncate_result(text: str, max_chars: int = 2000) -> str:
    """Cap tool result size to stay within token budget."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... (truncated)"


def _strip_tool_call_xml(text: str) -> str:
    """Remove tool_call XML from assistant messages before re-sending."""
    return TOOL_CALL_RE.sub("", text).strip()


def _try_skill_intercept(cfg: Config, prompt: str) -> OrchestratorResult | None:
    """If a local skill matches the prompt exactly, execute it and skip the LLM."""
    if not cfg.skill_intercept or not cfg.allow_shell:
        return None
    try:
        # Check for exact skill ID match first
        skill = skills_registry.get(prompt.strip())
        if not skill:
            matches = skills_registry.search(prompt)
            local_matches = [s for s in matches if s.target == "local" and s.script]
            if len(local_matches) != 1:
                return None
            skill = local_matches[0]
        if skill.target != "local" or not skill.script:
            return None
        script = skills_registry.render_script(skill, {})
        r = shell.run(script)
        text = f"[skill:{skill.id}] code={r.code}\n{r.stdout}"
        if r.stderr:
            text += f"\nstderr: {r.stderr}"
        return OrchestratorResult(text=text, messages=[], used_tools=[f"skill:{skill.id}"], intent="skill")
    except Exception:
        return None


def _parse_tool_call(text: str) -> dict | None:
    m = TOOL_CALL_RE.search(text)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(1))
        if not parsed.get("name"):
            return None
        return parsed
    except json.JSONDecodeError:
        return None


def _run_tool(cfg: Config, prompt: str, tc: dict) -> tuple[str, str]:
    """Returns (tool_name, result_text). Results are truncated to budget."""
    name = tc["name"]
    max_chars = cfg.tool_result_max_chars

    if name == "web_search":
        if not cfg.allow_search or cfg.offline:
            return name, "Web search unavailable: disabled or offline."
        return name, _truncate_result(web.search(str(tc.get("query", prompt))), max_chars)

    elif name == "rag_search":
        from .rag.vectordb import VectorStore
        client = get_client(cfg.chat_backend, url=cfg.ollama_url)
        db = VectorStore(cfg.db_path)
        query = str(tc.get("query", prompt))
        embeddings = client.embed(cfg.embed_model, [query])
        results = db.search(embeddings[0], k=int(tc.get("k", 5)))
        if not results:
            return name, "No results"
        return name, _truncate_result("\n---\n".join(f"# {r['path']}\n{r['content']}" for r in results), max_chars)

    elif name == "shell":
        if not cfg.allow_shell:
            return name, "Shell unavailable: enable with allow_shell."
        cmd = str(tc.get("command", tc.get("cmd", "")))
        if not cmd:
            return name, "Shell command missing."
        r = shell.run(cmd)
        return name, _truncate_result(f"code={r.code}\nstdout\n{r.stdout}\nstderr\n{r.stderr}", max_chars)

    elif name == "academic_search":
        if not cfg.allow_search or cfg.offline:
            return name, "Academic search unavailable."
        papers = academic.search(str(tc.get("query", prompt)), int(tc.get("limit", 10)))
        return name, _truncate_result(academic.format_results(papers), max_chars)

    else:
        return name, f"Unknown tool: {name}"


def run(cfg: Config, prompt: str, history: list[ChatMessage] | None = None,
        interactive: bool = False) -> OrchestratorResult:
    """Main orchestration loop."""
    # Skill-first: skip LLM entirely if a local skill matches
    skill_result = _try_skill_intercept(cfg, prompt)
    if skill_result is not None:
        return skill_result

    intent = classify_intent(prompt, cfg)

    if intent == "refuse":
        return OrchestratorResult(text="Request refused.", messages=[], used_tools=[], intent=intent)

    client = get_client(cfg.chat_backend, url=cfg.ollama_url)
    messages = list(history) if history else []

    if not any(m.role == "system" for m in messages):
        messages.insert(0, ChatMessage("system", _system_prompt(cfg, interactive)))

    tool_results: list[tuple[str, str]] = []

    # Inject memory — compact format with token budget
    if cfg.memory_enabled:
        try:
            entries = memory.load_recent(cfg.memory_max_entries)
            if entries:
                filtered = memory.relevance_filter(entries, prompt, max_entries=10)
                ctx = memory.format_compact(filtered, max_tokens=cfg.memory_max_tokens)
                if ctx:
                    messages.append(ChatMessage("system", f"Recent memory:\n{ctx}"))
                    tool_results.append(("memory", "Loaded recent memory."))
        except Exception:
            pass

    messages.append(ChatMessage("user", prompt))

    # Auto-ground if needed
    if intent == "ground":
        grounded = _truncate_result(web.search(prompt), cfg.tool_result_max_chars)
        messages.append(ChatMessage("tool", f"[web_search]\n{grounded}"))
        tool_results.append(("web_search", grounded))

    # Tool loop
    final_text = ""
    for _ in range(TOOL_MAX_STEPS):
        text = client.chat(cfg.base_model, messages, temperature=0.2)
        tc = _parse_tool_call(text)
        if not tc:
            final_text = text
            messages.append(ChatMessage("assistant", text))
            break

        name, result = _run_tool(cfg, prompt, tc)
        tool_results.append((name, result))
        # Strip tool_call XML from assistant msg before re-sending
        messages.append(ChatMessage("assistant", _strip_tool_call_xml(text)))
        messages.append(ChatMessage("tool", f"[{name}]\n{result}"))

    if not final_text:
        final_text = client.chat(cfg.base_model, messages, temperature=0.2)
        messages.append(ChatMessage("assistant", final_text))

    # Persist to memory
    if cfg.memory_enabled:
        try:
            memory.append(memory.MemoryEntry(
                ts=datetime.now().isoformat(),
                prompt=prompt, answer=final_text,
                tools=[n for n, _ in tool_results if n != "memory"],
            ))
        except Exception:
            pass

    used = list({n for n, _ in tool_results})
    return OrchestratorResult(text=final_text, messages=messages, used_tools=used, intent=intent)
