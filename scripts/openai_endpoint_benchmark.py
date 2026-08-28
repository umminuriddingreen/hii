#!/usr/bin/env python3
"""Benchmark OpenAI-compatible local endpoints for token/s latency metrics.

The script compares one or more endpoints using TTFT/latency/output-throughput
with tool-call validation and optional process RSS sampling.
"""

from __future__ import annotations

import argparse
import json
import statistics
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import http.client
import queue
import socket
import socketserver
import subprocess
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


def now_ms() -> float:
    return time.perf_counter() * 1000.0


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def estimate_tokens(text: str) -> int:
    return max(1, len(text.split()))


def parse_int(v: str) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def locate_pid(process_name: str) -> Optional[int]:
    try:
        result = subprocess.run(
            ["pgrep", "-x", process_name],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    pids = [p.strip() for p in result.stdout.splitlines() if p.strip()]
    if not pids:
        return None
    return parse_int(pids[0])


def get_rss_kb(pid: int) -> Optional[int]:
    try:
        result = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip()
    return parse_int(value)


def sample_rss(pid: int, interval_s: float, stop_signal: threading.Event, samples: List[int]) -> None:
    while not stop_signal.is_set():
        rss = get_rss_kb(pid)
        if rss is not None:
            samples.append(rss)
        stop_signal.wait(interval_s)


def tool_defs() -> List[Dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather by location.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "City and optional country.",
                        }
                    },
                    "required": ["location"],
                    "additionalProperties": False,
                },
            },
        }
    ]


def validate_tool_calls(message_or_calls: Dict[str, Any] | List[Dict[str, Any]]) -> bool:
    if isinstance(message_or_calls, list):
        calls = message_or_calls
    elif isinstance(message_or_calls, dict):
        calls = message_or_calls.get("tool_calls")
    else:
        return False
    if not isinstance(calls, list) or not calls:
        return False
    for call in calls:
        if not isinstance(call, dict):
            return False
        if call.get("type") != "function":
            return False
        function = call.get("function")
        if not isinstance(function, dict):
            return False
        if not isinstance(function.get("name"), str):
            return False
        if "arguments" in function:
            args = function.get("arguments")
            if not isinstance(args, str):
                return False
            try:
                json.loads(args)
            except json.JSONDecodeError:
                return False
    return True


def build_prompts() -> List[Dict[str, Any]]:
    return [
        {
            "id": "completion-stream",
            "stream": True,
            "messages": [
                {
                    "role": "user",
                    "content": "Reply with exactly: benchmark ok",
                }
            ],
            "tools": None,
            "expect_tool_calls": False,
        },
        {
            "id": "completion-nonstream",
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": "Reply with exactly: nonstream ok",
                }
            ],
            "tools": None,
            "expect_tool_calls": False,
        },
        {
            "id": "tool-call-stream",
            "stream": True,
            "messages": [
                {
                    "role": "user",
                    "content": "Use the provided tool to get weather for Austin, TX.",
                }
            ],
            "tools": tool_defs(),
            "expect_tool_calls": True,
        },
    ]


def normalize_endpoint(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path
    if path and path.endswith("/chat/completions"):
        return url
    if path and path.endswith("/api/chat"):
        return url
    if path and path.endswith("/api"):
        return url + "/chat"
    if path and path.endswith("/v1"):
        return url + "/chat/completions"
    return url.rstrip("/") + "/v1/chat/completions"


@dataclass
class Target:
    name: str
    endpoint: str
    model: str
    headers: Dict[str, str] = field(default_factory=dict)


@dataclass
class RunResult:
    target: str
    model: str
    run_id: str
    scenario: str
    start_at: str
    end_at: str
    stream: bool
    success: bool
    http_status: Optional[int]
    ttft_ms: Optional[float]
    total_latency_ms: Optional[float]
    prompt_tokens: Optional[int]
    completion_tokens: Optional[int]
    derived_output_tokens: Optional[int]
    tokens_per_second: Optional[float]
    output_chars: int
    tool_call_present: bool
    tool_call_count: int
    tool_call_valid: bool
    rss_kb_before: Optional[int]
    rss_kb_after: Optional[int]
    rss_kb_peak: Optional[int]
    error: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def read_json_bytes(
    url: str,
    payload: Dict[str, Any],
    timeout_s: float,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    encoded = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=encoded, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    if headers:
        for key, value in headers.items():
            request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        status = response.status
        body = response.read()
        return status, body


def read_streaming(
    url: str,
    payload: Dict[str, Any],
    timeout_s: float,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    encoded = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=encoded, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "text/event-stream")
    if headers:
        for key, value in headers.items():
            request.add_header(key, value)
    start = now_ms()
    first_token_ms: Optional[float] = None
    choices: List[Dict[str, Any]] = []
    usage = None
    content = []
    tool_calls = []
    http_status = None
    error = None

    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            http_status = response.status
            buffer = response.read().decode("utf-8", errors="replace")
    except Exception as ex:
        error = str(ex)
        return {
            "error": error,
            "status": None,
            "ttft_ms": None,
            "latency_ms": None,
            "choices": choices,
            "usage": usage,
            "content": "",
            "tool_calls": [],
            "first_token_ms": None,
            "stream_complete": False,
        }

    lines = [line.strip() for line in buffer.splitlines() if line.strip()]
    for raw_line in lines:
        if raw_line.startswith("data:"):
            raw_data = raw_line[5:].strip()
        else:
            raw_data = raw_line
        if raw_data == "[DONE]":
            continue
        try:
            chunk = json.loads(raw_data)
        except json.JSONDecodeError:
            continue
        if chunk.get("object") == "error":
            error = chunk.get("error", {}).get("message", "error payload")
            continue
        chunk_choices = chunk.get("choices") or []
        if isinstance(chunk_choices, list):
            for choice in chunk_choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") or {}
                if not isinstance(delta, dict):
                    continue
                delta_content = delta.get("content") or ""
                delta_tools = delta.get("tool_calls") or []
                if delta_content:
                    content.append(str(delta_content))
                if delta_tools:
                    if isinstance(delta_tools, list):
                        for tc in delta_tools:
                            if isinstance(tc, dict):
                                tool_calls.append(tc)
                    elif isinstance(delta_tools, dict):
                        tool_calls.append(delta_tools)
                if (not first_token_ms) and (delta_content or delta_tools):
                    first_token_ms = now_ms() - start
                choices.append(choice)
        chunk_usage = chunk.get("usage")
        if chunk_usage is not None:
            usage = chunk_usage
    if first_token_ms is None:
        first_token_ms = None
    latency_ms = now_ms() - start
    return {
        "error": error,
        "status": http_status,
        "ttft_ms": first_token_ms,
        "latency_ms": latency_ms,
        "choices": choices,
        "usage": usage,
        "content": "".join(content),
        "tool_calls": tool_calls,
        "stream_complete": True,
    }


def read_non_stream(
    url: str,
    payload: Dict[str, Any],
    timeout_s: float,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    start = now_ms()
    status = None
    error = None
    body = None
    try:
        status, body = read_json_bytes(url, payload, timeout_s, headers)
    except urllib.error.HTTPError as exc:
        error = f"{exc.code}: {exc.reason}"
        status = exc.code
        body = exc.read()
    except Exception as ex:
        error = str(ex)
    latency_ms = now_ms() - start
    if body is None:
        return {
            "error": error,
            "status": status,
            "ttft_ms": None,
            "latency_ms": latency_ms,
            "usage": None,
            "content": "",
            "tool_calls": [],
            "choices": [],
        }
    try:
        payload_json = json.loads(body.decode("utf-8"))
    except Exception:
        payload_json = {}
    if isinstance(payload_json, dict) and status is not None and status >= 400:
        err = payload_json.get("error", {})
        error = str(err.get("message", error or "http error"))
    usage = payload_json.get("usage")
    choices = payload_json.get("choices") if isinstance(payload_json, dict) else None
    content = ""
    tool_calls = []
    if isinstance(choices, list) and choices:
        first_choice = choices[0]
        if isinstance(first_choice, dict):
            msg = first_choice.get("message") or {}
            if isinstance(msg, dict):
                if isinstance(msg.get("content"), str):
                    content = msg.get("content")
                if isinstance(msg.get("tool_calls"), list):
                    tool_calls = msg.get("tool_calls")
    return {
        "error": error,
        "status": status,
        "ttft_ms": None,
        "latency_ms": latency_ms,
        "usage": usage,
        "content": content or "",
        "tool_calls": tool_calls,
        "choices": choices or [],
    }


def call_once(target: Target, scenario: Dict[str, Any], timeout_s: float, pid: Optional[int], rss_sample_interval: float) -> RunResult:
    run_id = str(uuid.uuid4())
    endpoint = normalize_endpoint(target.endpoint)
    started = utcnow_iso()

    payload: Dict[str, Any] = {
        "model": target.model,
        "messages": scenario["messages"],
        "stream": bool(scenario["stream"]),
    }
    if scenario.get("tools"):
        payload["tools"] = scenario["tools"]
        payload["tool_choice"] = "auto"

    rss_samples: List[int] = []
    rss_thread_stop = threading.Event()
    sampler = None
    if pid is not None:
        sampler = threading.Thread(
            target=sample_rss,
            args=(pid, rss_sample_interval, rss_thread_stop, rss_samples),
            daemon=True,
        )
        sampler.start()
        rss_before = get_rss_kb(pid)
    else:
        rss_before = None

    started_ms = now_ms()
    result_payload: Dict[str, Any]
    if scenario["stream"]:
        result_payload = read_streaming(endpoint, payload, timeout_s, target.headers)
    else:
        result_payload = read_non_stream(endpoint, payload, timeout_s, target.headers)

    if pid is not None:
        rss_thread_stop.set()
        if sampler is not None:
            sampler.join(timeout=1.0)
    rss_after = get_rss_kb(pid) if pid is not None else None
    rss_peak = max(rss_samples) if rss_samples else None

    error = result_payload.get("error")
    http_status = result_payload.get("status")
    ttft_ms = result_payload.get("ttft_ms")
    latency_ms = result_payload.get("latency_ms")
    usage = result_payload.get("usage") or {}
    tool_calls = result_payload.get("tool_calls") or []
    content = result_payload.get("content") or ""
    tool_call_count = len(tool_calls) if isinstance(tool_calls, list) else 0

    tool_valid = False
    if tool_calls:
        tool_valid = validate_tool_calls(tool_calls)

    if scenario.get("expect_tool_calls"):
        if tool_call_count < 1 or not tool_valid:
            if not error:
                error = "Expected tool call, but tool call output was missing or invalid."
            success = False
        else:
            success = error is None
    else:
        success = error is None

    status_code = parse_int(str(http_status)) if http_status is not None else None
    prompt_tokens = parse_int(str(usage.get("prompt_tokens"))) if isinstance(usage, dict) else None
    completion_tokens = parse_int(str(usage.get("completion_tokens"))) if isinstance(usage, dict) else None
    derived_tokens = None
    if completion_tokens is not None:
        derived_tokens = completion_tokens
    elif content is not None:
        derived_tokens = estimate_tokens(content)

    tps = None
    if latency_ms and latency_ms > 0 and derived_tokens is not None:
        tps = derived_tokens / (latency_ms / 1000.0)

    ended = utcnow_iso()

    return RunResult(
        target=target.name,
        model=target.model,
        run_id=run_id,
        scenario=scenario["id"],
        start_at=started,
        end_at=ended,
        stream=scenario["stream"],
        success=success and status_code is not None and status_code < 400,
        http_status=status_code,
        ttft_ms=ttft_ms,
        total_latency_ms=latency_ms,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        derived_output_tokens=derived_tokens,
        tokens_per_second=tps,
        output_chars=len(content),
        tool_call_present=tool_call_count > 0,
        tool_call_count=tool_call_count,
        tool_call_valid=tool_valid,
        rss_kb_before=rss_before,
        rss_kb_after=rss_after,
        rss_kb_peak=rss_peak,
        error=error,
    )


def parse_targets(raw_targets: List[str]) -> List[Target]:
    parsed: List[Target] = []
    for raw in raw_targets:
        entry = json.loads(raw)
        if not isinstance(entry, dict):
            raise ValueError(f"Target is not a JSON object: {raw}")
        if not isinstance(entry.get("name"), str):
            raise ValueError(f"Target name must be string: {raw}")
        if not isinstance(entry.get("url"), str):
            raise ValueError(f"Target url must be string: {raw}")
        if not isinstance(entry.get("model"), str):
            raise ValueError(f"Target model must be string: {raw}")
        headers = entry.get("headers")
        if headers is None:
            headers = {}
        if not isinstance(headers, dict):
            raise ValueError(f"Target headers must be object: {raw}")
        parsed.append(Target(name=entry["name"], endpoint=entry["url"], model=entry["model"], headers=headers))
    return parsed


def fake_server_runnable(bind_host: str = "127.0.0.1") -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "FakeLLM/1.0"

        def do_POST(self) -> None:  # noqa: N802
            payload = self._read_payload()
            if payload is None:
                self.send_error(HTTPStatus.BAD_REQUEST, "invalid json")
                return
            model = payload.get("model", "test")
            stream = bool(payload.get("stream", False))
            messages = payload.get("messages", [])
            has_tools = bool(payload.get("tools"))
            content = "ok"

            if isinstance(messages, list) and messages:
                last = messages[-1]
                if isinstance(last, dict):
                    content = str(last.get("content", "ok"))
                    if has_tools:
                        content = "tool needed"
            if not stream:
                response_obj = {
                    "id": f"cmpl-{uuid.uuid4().hex[:12]}",
                    "object": "chat.completion",
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": content,
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": max(1, len(content) // 2),
                        "completion_tokens": max(1, len(content.split())),
                        "total_tokens": max(1, len(content) // 2 + len(content.split())),
                    },
                }
                if has_tools:
                    response_obj["choices"][0]["message"]["tool_calls"] = [
                        {
                            "id": f"call-{uuid.uuid4().hex[:12]}",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": json.dumps({"location": "Austin, TX"}),
                            },
                        }
                    ]
                payload_bytes = json.dumps(response_obj).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload_bytes)))
                self.end_headers()
                self.wfile.write(payload_bytes)
                return

            # stream response
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            if has_tools:
                chunk = {
                    "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": f"tool-{uuid.uuid4().hex[:12]}",
                                        "type": "function",
                                        "function": {
                                            "name": "get_weather",
                                            "arguments": json.dumps({"location": "Austin, TX"}),
                                        },
                                    }
                                ]
                            },
                        }
                    ],
                }
                self._write_sse(chunk)
                time.sleep(0.02)

            chunk2 = {
                "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, "delta": {"content": content[:3]}}],
            }
            self._write_sse(chunk2)
            time.sleep(0.02)
            chunk3 = {
                "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, "delta": {"content": content[3:]}}],
                "usage": {
                    "prompt_tokens": max(1, len(content) // 2),
                    "completion_tokens": max(1, len(content.split())),
                    "total_tokens": max(1, len(content) // 2 + len(content.split())),
                },
            }
            self._write_sse(chunk3)
            self._write_sse({"choices": []})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True

        def _read_payload(self) -> Optional[Dict[str, Any]]:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return None

        def _write_sse(self, body: Dict[str, Any]) -> None:
            data = json.dumps(body)
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            self.wfile.flush()

        def log_message(self, fmt: str, *args: Any) -> None:
            return

    class ThreadingHTTPServerWithReuse(socketserver.TCPServer):
        allow_reuse_address = True

    sock = socket.socket()
    sock.bind((bind_host, 0))
    port = sock.getsockname()[1]
    sock.close()

    server = ThreadingHTTPServerWithReuse((bind_host, port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server._thread = thread
    server._port = port
    return server


def stop_fake_server(server: ThreadingHTTPServer) -> None:
    server.shutdown()
    server.server_close()


def run_benchmark(args: argparse.Namespace) -> List[RunResult]:
    targets = parse_targets(args.targets)
    prompts = build_prompts()
    pid = args.pid
    if args.process_name:
        pid = locate_pid(args.process_name)
    run_results: List[RunResult] = []

    for target in targets:
        for _ in range(args.runs):
            for prompt in prompts:
                run_results.append(
                    call_once(
                        target=target,
                        scenario=prompt,
                        timeout_s=args.timeout,
                        pid=pid,
                        rss_sample_interval=args.rss_poll_seconds,
                    )
                )
    return run_results


def summarize(results: List[RunResult]) -> Dict[str, Any]:
    by_target: Dict[str, List[RunResult]] = {}
    for item in results:
        by_target.setdefault(item.target, []).append(item)

    per_target = {}
    for name, rows in by_target.items():
        latencies = [r.total_latency_ms for r in rows if r.total_latency_ms is not None and r.success]
        ttft = [r.ttft_ms for r in rows if r.ttft_ms is not None and r.success and r.stream]
        tps = [r.tokens_per_second for r in rows if r.tokens_per_second is not None and r.success]
        success = sum(1 for r in rows if r.success)
        failures = len(rows) - success
        per_target[name] = {
            "runs": len(rows),
            "success": success,
            "failures": failures,
            "ttft_ms_p50": statistics.median(ttft) if ttft else None,
            "latency_ms_p50": statistics.median(latencies) if latencies else None,
            "tokens_per_sec_p50": statistics.median(tps) if tps else None,
            "tool_call_valid_rate": (sum(1 for r in rows if r.tool_call_valid) / len(rows)) if rows else 0.0,
        }
    return {
        "generated_at": utcnow_iso(),
        "target_count": len(by_target),
        "results": [r.as_dict() for r in results],
        "summary": per_target,
    }


def run_self_test() -> bool:
    print("running deterministic fake endpoint self-test")
    fake_server = fake_server_runnable("127.0.0.1")
    port = fake_server.server_address[1]
    target = Target(
        name="fake-local",
        endpoint=f"http://127.0.0.1:{port}/v1/chat/completions",
        model="qwen3.8:mock",
    )
    prompts = build_prompts()
    time.sleep(0.05)
    try:
        results = []
        for prompt in prompts:
            results.append(call_once(target=target, scenario=prompt, timeout_s=5, pid=None, rss_sample_interval=0.02))
        assert all(r.success for r in results), "fake endpoints should pass all scenarios"
        streamed = next(r for r in results if r.scenario == "completion-stream")
        toolrun = next(r for r in results if r.scenario == "tool-call-stream")
        assert streamed.ttft_ms is not None, "streaming ttft must be reported"
        assert toolrun.tool_call_valid, "tool call should validate"
        return True
    except AssertionError as error:
        print(f"self-test failed: {error}")
        return False
    finally:
        stop_fake_server(fake_server)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark OpenAI-compatible local model endpoints."
    )
    parser.add_argument(
        "--targets",
        action="append",
        required=False,
        help=(
            "Repeatable JSON object: "
            '{"name":"ollama","url":"http://127.0.0.1:11434/v1/chat/completions","model":"qwen3.8:27b-mlx"}'
        ),
    )
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--process-name", dest="process_name")
    parser.add_argument("--rss-poll-seconds", type=float, default=0.05)
    parser.add_argument("--output", default="/tmp/openai_endpoint_benchmark.json")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.self_test:
        ok = run_self_test()
        return 0 if ok else 2

    if not args.targets:
        raise SystemExit("No --targets supplied. Example: --targets '{\"name\":\"ollama\",...}'")

    results = run_benchmark(args)
    report = summarize(results)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
