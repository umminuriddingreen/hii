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

### Two ways a run can be about the server rather than the model

Both have happened here, both silently, and both now void the run instead of
printing a percentage.

**The model stops before it starts.** One run scored 55% because ten of
forty-two replies came back with `completion_tokens: 1`, `finish_reason: stop`
and empty content — the judges marked the empty strings wrong. It correlated
with `chat_template_kwargs.enable_thinking=false`, so the flag is now
`--thinking on|off|unset` and defaults to `unset`. Be careful about the
attribution though: after the fact the same flag, the same prompt and the same
task would not reproduce it, and `--thinking off` later scored 28/28. So the
flag is a suspect, not a proven cause; the transient server state it happened
during is at least as likely. What is certain is that a reply carrying one token
or fewer is not a wrong answer, and scoring it as one moved the headline number
by nineteen points.

**The server is not serving what you asked for.** llama.cpp answers with whatever
model it has loaded and does not refuse a request naming a different one, so
`--model` is a label, not a selector. A model swapped in mid-session is invisible
unless you look: the runs are now stamped with the model the *server* reported,
they say so when it differs from `--model`, and a run whose server changed
identity partway through is voided outright, because that percentage belongs to
no single model.

Thinking mode is slow enough to outrun the default 300 s per request. Raise
`--timeout` rather than reaching for the flag that silences it.

### Where the numbers stand

`qwen3.6-35b-a3b-agent`, 3 runs per task, temp 0.2, both paths against the same
server in the same sitting:

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

The comparison is only fair because `tools.py`'s prompt carries the same
restraint sentences the convention does. It did not at first, and the table then
was measuring an edit made to one side.

This does not carry over to the earlier reading of 93% tools / 79% convention,
which was a different model on a differently-behaved server. Treat that pair and
this one as two separate experiments. What this one establishes is that the path
HII actually ships is not the weaker one, which is what the earlier number had
implied.

Both remaining tools-array failures are restraint, and one is worse than a
refusal: asked for a 30 mm sphere it builds a 30 mm **box** and reports success.
The convention refuses that cleanly, 3/3. That task is the noisiest in the set —
it has scored 0/3 and 1/3 on the tools path across otherwise identical runs — so
read the direction, not the decimal. A path that silently produces the wrong
solid is not the safer one to ship at any score.

**Phase 2** routes the same prompts through the bridge and scores them by the
bridge's own verification verdict rather than by whether the model sounded
confident. It needs Rhino running with `Hii`.
