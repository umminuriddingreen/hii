#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from typing import Any


def _load_request() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("missing JSON payload")
    return json.loads(raw)


def main() -> int:
    try:
        from mlx_lm import generate, load
    except Exception as exc:
        print(json.dumps({
            "error": "mlx-lm import failed",
            "detail": f"{exc}",
            "hint": "Install mlx-lm with: pip install mlx-lm",
        }), file=sys.stderr)
        return 1

    try:
        req = _load_request()
        model_name = str(req["model"])
        messages = req.get("messages") or []
        temperature = float(req.get("temperature", 0.2))
        max_tokens = int(req.get("max_tokens", 800))

        model, tokenizer = load(model_name)
        if getattr(tokenizer, "chat_template", None) is not None:
            prompt = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        else:
            prompt = "\n".join(
                f"{message.get('role', 'user')}: {message.get('content', '')}"
                for message in messages
            )

        text = generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=max_tokens,
            temp=temperature,
            verbose=False,
        )
        print(json.dumps({"text": text}))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
