# Local-model evals for HII Rhino

Two phases, deliberately separate.

**`gate.py` — does a model emit valid, correct tool calls at all?**
No Rhino required. The catalogue in `tools.py` is the real one: eight schemas,
one per implemented bridge operation, nothing advertised that the bridge would
refuse. Scoring is strict about arguments, because a model that picks the right
tool and the wrong dimension has not succeeded at anything useful.

```
llama-server -m <model>.gguf --port 8090 -ngl 999 -fa on --jinja --alias <name>
python gate.py --model <name> --runs 3
```

**`gate_hii.py` — the same tasks through HII's own prompt convention.**
This is the number that decides anything. `gate.py` measures the OpenAI-style
`tools` array, which llama.cpp parses with the model's trained chat template.
HII's agent loop (`agent.rs:1723`) does something else: it names the tools in one
compressed line of the system prompt and parses bare JSON back. Only the second
one ships.

```
python gate_hii.py --endpoint http://127.0.0.1:8080 --model <name> --runs 3
```

Pin the temperature (default 0.2). At Qwen's recommended thinking-mode sampling
(temp 1.0) this measures sampling noise rather than capability.

**Do not pass `--thinking off` casually.** It sends
`chat_template_kwargs.enable_thinking=false`, and some Qwen3.8 builds read that
as permission to emit the stop token immediately — one completion token, empty
content, every task scored wrong. That is why the flag defaults to `unset` and
why a reply carrying one token or fewer voids the run instead of scoring it. A
run that prints `VOID` measured the server, not the model; fix it and re-run
rather than reporting the percentage.

Thinking mode is slow enough to outrun the default 300 s per request. Raise
`--timeout` rather than reaching for the flag that silences it.

### Where the numbers stand

`qwen3.8-27b-agent`, 3 runs per task, temp 0.2:

| Path | Score |
| --- | --- |
| HII prompt convention (`gate_hii.py`) | **41/42 (98%)** |
| tools array (`gate.py`) | 36/42 (86%) |

The convention started at 31/42 and now leads. The gap was never syntax — no
malformed JSON on either path — it was the two things the compressed line
dropped: one clause per tool saying what it is for, and the enums bounding `kind`
and `anchor`. The last stubborn failure was self-inflicted: the `Create:` example
used `size_mm: 40`, and asked to create a box with no size the model copied the
example rather than asking. An example is a default unless it says it is not.

This inverts the earlier reading (93% tools / 79% convention), which was measured
on the 9B — these are different models, so it is not the same comparison twice.
What it does establish is that the shipping path is not the weaker one, which is
what the earlier number had implied.

Both remaining tools-array failures are restraint, and one is worse than a
refusal: asked for a 30 mm sphere it builds a 30 mm **box** and reports success.
The convention refuses that cleanly, 3/3. A path that scores a few points lower
on syntax while silently producing the wrong solid is not the safer one to ship.

**Phase 2** routes the same prompts through the bridge and scores them by the
bridge's own verification verdict rather than by whether the model sounded
confident. It needs Rhino running with `Hii`.
