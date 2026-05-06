"""Token overhead benchmark for HII agent harness.

Measures token cost of each orchestrator component to identify
optimization targets. Uses tiktoken (cl100k_base) for counting.

Run: pytest tests/test_token_overhead.py -v -s
"""

from __future__ import annotations
import json
import time
from dataclasses import dataclass
from unittest.mock import patch, MagicMock
from datetime import datetime

import pytest

from hii.config import Config
from hii.llm.base import ChatMessage
from hii.orchestrator import _system_prompt, _truncate_result, _strip_tool_call_xml, classify_intent, run, TOOL_CALL_RE
from hii.memory import MemoryEntry, format_for_context, format_compact, relevance_filter
from hii.skills.registry import Skill, render_script, render_prompt


# ---------------------------------------------------------------------------
# Token counter — use tiktoken if available, else rough word estimate
# ---------------------------------------------------------------------------

try:
    import tiktoken
    _ENC = tiktoken.get_encoding("cl100k_base")

    def count_tokens(text: str) -> int:
        return len(_ENC.encode(text))
except ImportError:
    def count_tokens(text: str) -> int:
        # ~0.75 words per token heuristic
        return int(len(text.split()) / 0.75)


def tokens_for_messages(msgs: list[ChatMessage]) -> int:
    """Total tokens across all messages (content only, ignores role overhead)."""
    return sum(count_tokens(m.content) for m in msgs)


def msg_role_overhead(msgs: list[ChatMessage]) -> int:
    """Estimate per-message role/framing overhead (~4 tokens per message for most APIs)."""
    return len(msgs) * 4


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def cfg():
    return Config(
        chat_backend="ollama",
        base_model="test-model",
        embed_model="nomic-embed-text",
        allow_shell=False,
        allow_search=False,
        offline=True,
        memory_enabled=False,
    )


@pytest.fixture
def cfg_with_memory(cfg):
    cfg.memory_enabled = True
    cfg.memory_max_entries = 30
    return cfg


def _make_memory_entries(n: int, prompt_len: int = 20, answer_len: int = 60) -> list[MemoryEntry]:
    """Generate n synthetic memory entries with controlled sizes."""
    return [
        MemoryEntry(
            ts=f"2026-04-20T10:{i:02d}:00",
            prompt=" ".join(["word"] * prompt_len),
            answer=" ".join(["word"] * answer_len),
            tools=["shell"] if i % 3 == 0 else [],
        )
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# 1. System prompt overhead
# ---------------------------------------------------------------------------

class TestSystemPromptOverhead:
    def test_system_prompt_tokens(self, cfg):
        sp = _system_prompt(cfg, interactive=False)
        toks = count_tokens(sp)
        print(f"\n  System prompt (non-interactive): {toks} tokens")
        assert toks < 200, f"System prompt too large: {toks} tokens"

    def test_system_prompt_interactive(self, cfg):
        sp = _system_prompt(cfg, interactive=True)
        toks = count_tokens(sp)
        print(f"\n  System prompt (interactive): {toks} tokens")
        assert toks < 200

    def test_system_prompt_delta(self, cfg):
        base = count_tokens(_system_prompt(cfg, interactive=False))
        full = count_tokens(_system_prompt(cfg, interactive=True))
        delta = full - base
        print(f"\n  Interactive mode adds {delta} tokens")


# ---------------------------------------------------------------------------
# 2. Memory injection overhead
# ---------------------------------------------------------------------------

class TestMemoryOverhead:
    @pytest.mark.parametrize("n_entries", [1, 5, 10, 20, 30])
    def test_memory_context_scaling(self, n_entries):
        entries = _make_memory_entries(n_entries)
        ctx = format_for_context(entries)
        toks = count_tokens(ctx)
        per_entry = toks / n_entries
        print(f"\n  Memory ({n_entries} entries): {toks} tokens total, {per_entry:.0f}/entry")

    def test_memory_30_entries_budget(self):
        """30 entries (default max) should stay under 3000 tokens."""
        entries = _make_memory_entries(30)
        ctx = format_for_context(entries)
        toks = count_tokens(ctx)
        print(f"\n  Memory (30 entries, default max): {toks} tokens")
        assert toks < 3000, f"Memory context too large at default settings: {toks}"

    def test_memory_real_world_sizes(self):
        """Simulate realistic prompt/answer lengths."""
        entries = [
            MemoryEntry(
                ts="2026-04-20T10:00:00",
                prompt="How do I configure the daemon to auto-restart workers?",
                answer="Use `hii daemon start` with worker specs in ~/.hii/workers.json. "
                       "Set restart_on_crash: true and max_restarts to your desired limit.",
                tools=["shell"],
            ),
            MemoryEntry(
                ts="2026-04-20T10:05:00",
                prompt="Search for papers on cognitive architectures",
                answer="Found 10 results on arXiv. Top: ACT-R unified theory (Anderson 2004), "
                       "Soar cognitive architecture (Laird 2012), Global Workspace Theory...",
                tools=["academic_search"],
            ),
        ] * 15  # 30 entries
        ctx = format_for_context(entries)
        toks = count_tokens(ctx)
        print(f"\n  Memory (30 real-world entries): {toks} tokens")


# ---------------------------------------------------------------------------
# 3. Tool call XML overhead
# ---------------------------------------------------------------------------

class TestToolCallOverhead:
    def test_tool_call_xml_framing(self):
        """Measure overhead of the XML tool_call wrapper."""
        bare = '{"name":"web_search","query":"latest news"}'
        wrapped = f'<tool_call>{bare}</tool_call>'
        delta = count_tokens(wrapped) - count_tokens(bare)
        print(f"\n  Tool call XML wrapper: +{delta} tokens")
        assert delta < 15

    def test_tool_result_injection(self):
        """Measure overhead of injecting a tool result as a message."""
        result = "Found 5 results for 'cognitive architectures':\n1. ACT-R...\n2. Soar..."
        framed = f"[web_search]\n{result}"
        overhead = count_tokens(framed) - count_tokens(result)
        print(f"\n  Tool result framing: +{overhead} tokens")

    @pytest.mark.parametrize("n_steps", [1, 2, 3, 5])
    def test_multi_step_accumulation(self, n_steps):
        """Measure how token cost grows with tool loop iterations."""
        msgs = [ChatMessage("system", "You are HII.")]
        msgs.append(ChatMessage("user", "Find papers on memory systems"))
        for i in range(n_steps):
            msgs.append(ChatMessage("assistant", f'<tool_call>{{"name":"web_search","query":"step {i}"}}</tool_call>'))
            msgs.append(ChatMessage("tool", f"[web_search]\nResult {i}: " + "x " * 50))
        msgs.append(ChatMessage("assistant", "Here are the results."))
        total = tokens_for_messages(msgs) + msg_role_overhead(msgs)
        print(f"\n  {n_steps}-step tool loop: {total} tokens (content + role overhead)")


# ---------------------------------------------------------------------------
# 4. Full orchestrator pass — end-to-end token accounting
# ---------------------------------------------------------------------------

class TestOrchestratorTokenBudget:
    def test_simple_query_no_tools(self, cfg):
        """Baseline: simple query, no tools, no memory."""
        with patch("hii.orchestrator.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.return_value = "42"
            mock_get.return_value = mock_client

            result = run(cfg, "What is 6 * 7?")

            call_args = mock_client.chat.call_args
            messages = call_args[0][1]
            total = tokens_for_messages(messages) + msg_role_overhead(messages)
            print(f"\n  Simple query (no tools/memory): {total} tokens sent to LLM")
            print(f"    Messages: {len(messages)} ({', '.join(m.role for m in messages)})")
            for m in messages:
                print(f"    [{m.role}] {count_tokens(m.content)} tokens")

    def test_query_with_memory(self, cfg_with_memory):
        """Query with memory injection — measure added cost."""
        entries = _make_memory_entries(10)
        with patch("hii.orchestrator.get_client") as mock_get, \
             patch("hii.orchestrator.memory.load_recent", return_value=entries):
            mock_client = MagicMock()
            mock_client.chat.return_value = "Done."
            mock_get.return_value = mock_client

            result = run(cfg_with_memory, "Check daemon status")

            messages = mock_client.chat.call_args[0][1]
            total = tokens_for_messages(messages) + msg_role_overhead(messages)
            print(f"\n  Query + 10 memory entries: {total} tokens")
            for m in messages:
                print(f"    [{m.role}] {count_tokens(m.content)} tokens")

    def test_query_with_tool_loop(self, cfg):
        """Query triggering one tool call."""
        call_count = 0

        def fake_chat(model, messages, temperature=0.2):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return '<tool_call>{"name":"shell","command":"echo hello"}</tool_call>'
            return "Shell returned: hello"

        cfg.allow_shell = True
        with patch("hii.orchestrator.get_client") as mock_get, \
             patch("hii.orchestrator.shell.run") as mock_shell:
            mock_client = MagicMock()
            mock_client.chat.side_effect = fake_chat
            mock_get.return_value = mock_client
            mock_shell.return_value = MagicMock(code=0, stdout="hello", stderr="")

            result = run(cfg, "Run echo hello")

            # Get the LAST call's messages (accumulated)
            last_messages = mock_client.chat.call_args_list[-1][0][1]
            total = tokens_for_messages(last_messages) + msg_role_overhead(last_messages)
            print(f"\n  Query + 1 tool call: {total} tokens on final LLM call")
            print(f"    Messages: {len(last_messages)}")
            for m in last_messages:
                print(f"    [{m.role}] {count_tokens(m.content)} tokens")


# ---------------------------------------------------------------------------
# 5. Skill system efficiency
# ---------------------------------------------------------------------------

class TestSkillEfficiency:
    def test_skill_vs_freeform_tokens(self):
        """Compare: executing a skill script vs. free-form LLM reasoning."""
        skill = Skill(
            id="daemon-status",
            name="Check Daemon Status",
            description="Show HII daemon process status",
            category="daemon",
            target="local",
            inputs={},
            script="hii daemon status",
            examples=["hii skill run daemon-status"],
            tags=["daemon", "status"],
        )
        # Skill execution: just the script string
        script = render_script(skill, {})
        skill_tokens = count_tokens(script)

        # Free-form: the prompt you'd need to get the same result
        freeform_prompt = (
            "Check if the HII daemon is running. Use the daemon CLI to get status. "
            "Parse the output and report whether it's active."
        )
        freeform_tokens = count_tokens(freeform_prompt)

        savings = freeform_tokens - skill_tokens
        print(f"\n  Skill execution: {skill_tokens} tokens")
        print(f"  Free-form prompt: {freeform_tokens} tokens")
        print(f"  Savings: {savings} tokens ({savings/freeform_tokens*100:.0f}%)")

    def test_skill_index_lookup_cost(self):
        """Measure token cost of loading skill index for search."""
        # Simulate a 100-skill index
        index = [
            {"id": f"skill-{i}", "name": f"Skill Number {i}", "category": "test",
             "target": "local", "description": f"Does thing number {i} efficiently"}
            for i in range(100)
        ]
        index_text = json.dumps(index)
        toks = count_tokens(index_text)
        print(f"\n  100-skill index: {toks} tokens (if loaded into context)")
        print(f"  Per skill: {toks/100:.1f} tokens")


# ---------------------------------------------------------------------------
# 6. Compact memory regression
# ---------------------------------------------------------------------------

class TestCompactMemory:
    def test_compact_under_budget(self):
        """30 entries in compact format must stay under 800 tokens."""
        entries = _make_memory_entries(30)
        ctx = format_compact(entries, max_tokens=800)
        toks = count_tokens(ctx)
        print(f"\n  Compact memory (30 entries, budget=800): {toks} tokens")
        assert toks <= 800, f"Compact format exceeded budget: {toks}"

    def test_compact_vs_full(self):
        """Compact format should be significantly smaller than full."""
        entries = _make_memory_entries(30)
        full_toks = count_tokens(format_for_context(entries))
        compact_toks = count_tokens(format_compact(entries, max_tokens=800))
        savings = (1 - compact_toks / full_toks) * 100
        print(f"\n  Full: {full_toks}, Compact: {compact_toks}, Savings: {savings:.0f}%")
        assert savings > 50

    def test_relevance_filter(self):
        """Relevance filter should prioritize matching entries."""
        entries = [
            MemoryEntry(ts="t1", prompt="configure the daemon", answer="use hii daemon start", tools=[]),
            MemoryEntry(ts="t2", prompt="search for papers", answer="found 10 results", tools=[]),
            MemoryEntry(ts="t3", prompt="daemon status check", answer="running pid=123", tools=["shell"]),
        ]
        filtered = relevance_filter(entries, "daemon", max_entries=2)
        assert len(filtered) == 2
        assert all("daemon" in e.prompt for e in filtered)


# ---------------------------------------------------------------------------
# 7. Truncation regression
# ---------------------------------------------------------------------------

class TestTruncation:
    def test_short_text_unchanged(self):
        assert _truncate_result("short", 2000) == "short"

    def test_long_text_truncated(self):
        long = "x" * 5000
        result = _truncate_result(long, 2000)
        assert len(result) < 2100
        assert result.endswith("... (truncated)")

    def test_strip_tool_call_xml(self):
        text = 'Let me search. <tool_call>{"name":"web_search","query":"test"}</tool_call>'
        stripped = _strip_tool_call_xml(text)
        assert "<tool_call>" not in stripped
        assert "Let me search." in stripped


# ---------------------------------------------------------------------------
# 8. Skill intercept regression
# ---------------------------------------------------------------------------

class TestSkillIntercept:
    def test_skill_intercept_skips_llm(self):
        """When a skill matches, the LLM should never be called."""
        cfg = Config(
            chat_backend="ollama", base_model="test-model",
            embed_model="nomic-embed-text", allow_shell=True,
            allow_search=False, offline=True, memory_enabled=False,
            skill_intercept=True,
        )
        test_skill = Skill(
            id="daemon-status", name="Daemon Status", description="Check daemon status",
            category="daemon", target="local", inputs={}, script="echo running",
        )
        with patch("hii.orchestrator.skills_registry.get", return_value=test_skill), \
             patch("hii.orchestrator.skills_registry.render_script", return_value="echo running"), \
             patch("hii.orchestrator.shell.run") as mock_shell, \
             patch("hii.orchestrator.get_client") as mock_llm:
            mock_shell.return_value = MagicMock(code=0, stdout="running", stderr="")
            result = run(cfg, "daemon-status")
            mock_llm.assert_not_called()
            assert "running" in result.text
            assert result.intent == "skill"

    def test_skill_intercept_disabled(self):
        """When skill_intercept=False, always go to LLM."""
        cfg = Config(
            chat_backend="ollama", base_model="test-model",
            embed_model="nomic-embed-text", allow_shell=True,
            allow_search=False, offline=True, memory_enabled=False,
            skill_intercept=False,
        )
        with patch("hii.orchestrator.skills_registry.get", return_value=None), \
             patch("hii.orchestrator.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.chat.return_value = "result"
            mock_get.return_value = mock_client
            result = run(cfg, "daemon-status")
            mock_client.chat.assert_called()


# ---------------------------------------------------------------------------
# 9. Optimization recommendations (printed summary)
# ---------------------------------------------------------------------------

class TestOptimizationReport:
    def test_print_overhead_summary(self, cfg):
        """Generate a summary of all overhead sources with optimization suggestions."""
        sp = _system_prompt(cfg)
        sp_toks = count_tokens(sp)

        mem_entries = _make_memory_entries(30)
        mem_toks = count_tokens(format_for_context(mem_entries))

        tool_xml = count_tokens('<tool_call>{"name":"web_search","query":"test"}</tool_call>')

        # Single tool loop step: assistant + tool messages
        step_msgs = [
            ChatMessage("assistant", '<tool_call>{"name":"shell","command":"ls"}</tool_call>'),
            ChatMessage("tool", "[shell]\ncode=0\nstdout\nfile1.py\nfile2.py\nstderr\n"),
        ]
        step_toks = tokens_for_messages(step_msgs) + msg_role_overhead(step_msgs)

        # Compact memory (new)
        compact_toks = count_tokens(format_compact(mem_entries, max_tokens=800))

        print("\n" + "=" * 60)
        print("  HII TOKEN OVERHEAD REPORT (BEFORE / AFTER)")
        print("=" * 60)
        print(f"  System prompt:          {sp_toks:>6} tokens")
        print(f"  Memory BEFORE (30 raw): {mem_toks:>6} tokens")
        print(f"  Memory AFTER (compact): {compact_toks:>6} tokens  <- {(1-compact_toks/mem_toks)*100:.0f}% savings")
        print(f"  Tool call XML:          {tool_xml:>6} tokens/call")
        print(f"  Tool loop step:         {step_toks:>6} tokens/step")
        print(f"  Message role overhead:  {4:>6} tokens/msg")
        print("-" * 60)
        baseline = sp_toks + 20
        before_mem = baseline + mem_toks
        after_mem = baseline + compact_toks
        print(f"  BEFORE (baseline+mem):  {before_mem:>6} tokens")
        print(f"  AFTER  (baseline+mem):  {after_mem:>6} tokens  <- {(1-after_mem/before_mem)*100:.0f}% reduction")
        print(f"  + 1 tool step:          {after_mem + step_toks:>6} tokens")
        print(f"  + 3 tool steps:         {after_mem + step_toks * 3:>6} tokens")
        print(f"  Skill intercept:        {0:>6} tokens  (LLM bypassed entirely)")
        print("=" * 60)
