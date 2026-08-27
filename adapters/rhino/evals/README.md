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

Pin the temperature (default 0.2). At Qwen's recommended thinking-mode sampling
(temp 1.0) this measures sampling noise rather than capability.

**Phase 2** routes the same prompts through the bridge and scores them by the
bridge's own verification verdict rather than by whether the model sounded
confident. It needs Rhino running with `Hii`.
