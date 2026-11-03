#!/usr/bin/env python3
"""Prove local CUDA JSON, long-context retrieval and tool calls, then stop only our server."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.request


def run(args):
    if args.output.exists():
        raise RuntimeError("Refusing to overwrite a smoke receipt")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    key = args.api_key_file.read_text().strip()
    if not key:
        raise RuntimeError("Credential reference is empty")
    with socket.socket() as check:
        check.bind(("127.0.0.1", args.port))
    endpoint = f"http://127.0.0.1:{args.port}"
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    # Ignore proxy environment for this explicitly loopback-only proof.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    command = [args.binary, "--model", args.model, "--alias", "hii-cuda-proof",
               "--host", "127.0.0.1", "--port", str(args.port),
               "--api-key-file", str(args.api_key_file), "--ctx-size", "16384",
               "--n-gpu-layers", "999", "--flash-attn", "on", "--cache-type-k", "q4_0",
               "--cache-type-v", "q4_0", "--batch-size", "512", "--ubatch-size", "128",
               "--threads", "16", "--threads-batch", "24", "--parallel", "1",
               "--reasoning", "off", "--jinja", "--no-webui", "--offline"]
    with args.output.with_suffix(".log").open("x") as log:
        server = subprocess.Popen(command, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 120
            while True:
                if server.poll() is not None:
                    raise RuntimeError(f"Proof server exited {server.returncode}; inspect local log")
                try:
                    request = urllib.request.Request(endpoint + "/health", headers=headers)
                    with opener.open(request, timeout=2) as response:
                        if response.status == 200:
                            break
                except Exception:
                    if time.monotonic() > deadline:
                        raise RuntimeError("Proof server readiness timeout") from None
                    time.sleep(0.5)
            prompts = [
                ("short", 'Return only this JSON object: {"sum":42,"status":"ok"}'),
                ("long", "The first marker is HII-731.\n" + "\n".join(
                    f"Reference {index}: retain provenance and ignore irrelevant material."
                    for index in range(512)) + "\nThe last marker is END-294. Return only a JSON object with first and last set to those two marker strings."),
                ("tool", "Call add_integers with a=19 and b=23. Do not calculate it yourself."),
            ]
            results = []
            for name, prompt in prompts:
                body = {"model": "hii-cuda-proof", "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0, "max_tokens": 128, "chat_template_kwargs": {"enable_thinking": False}}
                if name == "tool":
                    body["tools"] = [{"type": "function", "function": {"name": "add_integers", "description": "Add two integers", "parameters": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}, "required": ["a", "b"], "additionalProperties": False}}}]
                    body["tool_choice"] = {"type": "function", "function": {"name": "add_integers"}}
                started = time.monotonic()
                request = urllib.request.Request(endpoint + "/v1/chat/completions", data=json.dumps(body).encode(), headers=headers)
                with opener.open(request, timeout=120) as response:
                    result = json.load(response)
                choice = result["choices"][0]
                if name == "tool":
                    calls = choice["message"].get("tool_calls", [])
                    passed = len(calls) == 1 and calls[0]["function"]["name"] == "add_integers" and json.loads(calls[0]["function"]["arguments"]) == {"a": 19, "b": 23}
                else:
                    expected = {"sum": 42, "status": "ok"} if name == "short" else {"first": "HII-731", "last": "END-294"}
                    passed = json.loads(choice["message"]["content"]) == expected
                passed = passed and choice["finish_reason"] in ("stop", "tool_calls")
                results.append({"workload": name, "passed": passed, "wallMs": (time.monotonic() - started) * 1000, "usage": result.get("usage"), "timings": result.get("timings")})
                print(json.dumps(results[-1]), flush=True)
            report = {"schemaVersion": 1, "kind": "hii.cuda.server-smoke", "contextTokens": 16384,
                      "modelPath": args.model, "results": results, "passed": all(row["passed"] for row in results)}
            with args.output.open("x") as target:
                json.dump(report, target, indent=2)
            if not report["passed"]:
                raise RuntimeError("One or more correctness checks failed")
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, default=11439)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Use an unprivileged TCP port")
    run(args)
