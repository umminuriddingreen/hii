#!/usr/bin/env python3
"""Local-only smoke test for raw HII CLI conversation and shell presentation.

The binary must already exist (set HII_CLI_BIN). This script starts a fake
OpenAI-compatible llama.cpp endpoint on loopback and uses isolated runtime and
workspace directories. It has no third-party Python dependencies.
"""

from __future__ import annotations

import http.server
import json
import os
import selectors
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


MODEL = "hii-raw-smoke-model"
PROFILE_SENTINEL = "RAW_SMOKE_PROFILE_SENTINEL"
LESSON_SENTINEL = "RAW_SMOKE_LESSON_SENTINEL"
AGENTS_SENTINEL = "RAW_SMOKE_AGENTS_SENTINEL"
SHELL_END = "RAW_SMOKE_SHELL_END"
STDERR_MARKER = "RAW_SMOKE_STDERR"
VERIFY_MARKER = "RAW_SMOKE_VERIFIED"
CODE_FENCE_MARKER = "RAW_SMOKE_CODE_FENCE_END"
COMMENTARY = "I’ll run a short shell check and verify its output."
FINAL_SUMMARY = "The shell check completed and its output was verified."
AGENT_FINAL = "The native shell smoke command completed."


def action(tool: str, command: str) -> str:
    return json.dumps({"type": tool, "command": command}, separators=(",", ":"))


def printf_command(value: str, *, stderr: bool = False) -> str:
    # POSIX printf %b uses the four-character \0ddd escape on macOS.
    octal = "".join(f"\\0{byte:03o}" for byte in value.encode("utf-8"))
    redirection = " >&2" if stderr else ""
    return f"printf '%b\\n' '{octal}'{redirection}"


def completion_events(content: str) -> list[bytes]:
    # Intentionally awkward, small boundaries exercise the streaming parser
    # across partial JSON keys, escape sequences, and ordinary prose.
    widths = (1, 2, 5, 3, 7, 4)
    parts: list[str] = []
    offset = 0
    index = 0
    while offset < len(content):
        width = widths[index % len(widths)]
        parts.append(content[offset : offset + width])
        offset += width
        index += 1
    events = []
    for part in parts:
        event = {"choices": [{"index": 0, "delta": {"content": part}}]}
        events.append(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
    events.append(
        b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    )
    events.append(b"data: [DONE]\n\n")
    return events


class FakeModelServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int]):
        super().__init__(address, FakeModelHandler)
        self.requests: list[dict[str, Any]] = []
        self.chat_index = 0
        self.request_lock = threading.Lock()


class FakeModelHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        pass

    def _send_json(self, payload: Any) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/v1/models":
            self._send_json({"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        elif self.path == "/health":
            self._send_json({"status": "ok", "loaded_model": MODEL})
        else:
            self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        try:
            request = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400)
            return

        if self.path == "/apply-template":
            prompt = "\n".join(
                str(message.get("content", ""))
                for message in request.get("messages", [])
                if isinstance(message, dict)
            )
            self._send_json({"prompt": prompt})
            return
        if self.path == "/tokenize":
            content = str(request.get("content", ""))
            self._send_json({"tokens": list(range(max(1, len(content) // 4)))})
            return
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        with self.server.request_lock:  # type: ignore[attr-defined]
            index = self.server.chat_index  # type: ignore[attr-defined]
            self.server.chat_index += 1  # type: ignore[attr-defined]
            self.server.requests.append(request)  # type: ignore[attr-defined]
        prompt = json.dumps(request.get("messages", []), ensure_ascii=False)

        if "ordinary code fenced shell example" in prompt:
            content = f"Here is a shell example:\n```sh\n# {CODE_FENCE_MARKER} is just an example marker.\nprintf 'hello\\n'\n```"
        elif VERIFY_MARKER in prompt:
            content = json.dumps(
                {
                    "type": "final",
                    "summary": AGENT_FINAL if "RAW_SMOKE_AGENT_" in prompt else FINAL_SUMMARY,
                    "verification": [printf_command(VERIFY_MARKER)],
                    "next": None,
                },
                separators=(",", ":"),
            )
        elif SHELL_END in prompt:
            content = action("verify", printf_command(VERIFY_MARKER))
        elif "RAW_SMOKE_AGENT_RUN" in prompt or "RAW_SMOKE_AGENT_JSONL" in prompt:
            if SHELL_END in prompt:
                content = json.dumps(
                    {"type": "final", "summary": AGENT_FINAL, "verification": [], "next": None},
                    separators=(",", ":"),
                )
            else:
                content = action(
                    "shell",
                    f"{printf_command('ok')}; {printf_command(STDERR_MARKER, stderr=True)}; sleep 1; {printf_command(SHELL_END)}",
                )
        elif AGENTS_SENTINEL in prompt:
            content = action(
                "shell",
                f"{printf_command('ok')}; {printf_command(STDERR_MARKER, stderr=True)}; sleep 1; {printf_command(SHELL_END)}",
            )
        elif "run one shell command and verify its output" in prompt:
            content = COMMENTARY + "\n" + action(
                "shell",
                f"{printf_command('ok')}; {printf_command(STDERR_MARKER, stderr=True)}; sleep 1; {printf_command(SHELL_END)}",
            )
        else:
            content = json.dumps(
                {"type": "final", "summary": FINAL_SUMMARY, "verification": [], "next": None},
                separators=(",", ":"),
            )

        events = completion_events(content)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(sum(map(len, events))))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for event in events:
                self.wfile.write(event)
                self.wfile.flush()
                time.sleep(0.004)
        except (BrokenPipeError, ConnectionResetError):
            pass


def read_until(process: subprocess.Popen[bytes], captured: bytearray, needle: bytes,
               deadline: float, *, select_timeout: float = 0.1) -> float:
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    found_at = 0.0
    try:
        while time.monotonic() < deadline:
            if needle in captured:
                found_at = time.monotonic()
                break
            if process.poll() is not None:
                break
            ready = selector.select(min(select_timeout, max(0.0, deadline - time.monotonic())))
            for key, _ in ready:
                chunk = os.read(key.fd, 4096)
                if chunk:
                    captured.extend(chunk)
                else:
                    return found_at
    finally:
        selector.close()
    if not found_at:
        text = captured.decode("utf-8", "replace")
        raise AssertionError(
            f"process ended or timed out without {needle!r}; exit={process.poll()}\n{text}"
        )
    return found_at


def assert_contains_once(text: str, value: str) -> None:
    count = text.count(value)
    if count != 1:
        raise AssertionError(f"expected {value!r} exactly once, found {count}\n{text}")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def isolated_env(root: Path, home: Path, runtime: Path, endpoint: str) -> dict[str, str]:
    env = os.environ.copy()
    # Inherited runtime credentials can point outside the isolated fixture.
    env.pop("HII_MODEL_API_KEY", None)
    env.pop("HII_MODEL_API_KEY_FILE", None)
    env.update(
        {
            "HOME": str(home),
            "HII_ROOT": str(root),
            "HII_RUNTIME_DIR": str(runtime),
            "HII_MODEL_URL": endpoint,
            "HII_MODEL_PROVIDER": "llama.cpp",
            "HII_MODEL_API_KEY": "raw-smoke-local-fixture",
            "HII_REASONING": "off",
            "HII_STRICT_ACTION_SCHEMA": "1",
        }
    )
    return env


def run_smoke(binary: Path) -> dict[str, Any]:
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="hii-cli-raw-smoke-") as temporary:
        base = Path(temporary)
        home = base / "home"
        runtime = base / "runtime"
        workspace = base / "workspace"
        for directory in (home, runtime, workspace, runtime / "learning"):
            directory.mkdir(parents=True, exist_ok=True)
        (runtime / "profile.md").write_text(PROFILE_SENTINEL)
        (runtime / "learning" / "verified-lessons.md").write_text(LESSON_SENTINEL)
        (workspace / "AGENTS.md").write_text(AGENTS_SENTINEL)

        server = FakeModelServer(("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{server.server_address[1]}"
        env = isolated_env(root, home, runtime, endpoint)
        env.update(
            {
                "HII_UI_LINE_MODE": "1",
                "HII_REASONING": "off",
                "HII_STRICT_ACTION_SCHEMA": "1",
            }
        )
        command = [
            str(binary),
            "--no-hooks",
            "--cwd",
            str(workspace),
            "--model",
            MODEL,
        ]
        process = subprocess.Popen(
            command,
            cwd=workspace,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )
        captured = bytearray()
        try:
            assert process.stdin is not None
            process.stdin.write(b"run one shell command and verify its output\n")
            process.stdin.flush()

            started = time.monotonic()
            first_tool_output_at = read_until(
                process,
                captured,
                b"ok\n",
                started + 20,
            )
            if SHELL_END.encode() in captured:
                raise AssertionError("shell output arrived only after the delayed command ended")
            shell_end_at = read_until(
                process,
                captured,
                SHELL_END.encode(),
                started + 25,
            )
            if shell_end_at - first_tool_output_at < 0.40:
                raise AssertionError(
                    "CLI did not expose shell output before the command's delay elapsed:\n"
                    + captured.decode("utf-8", "replace")
                )

            final_seen_at = read_until(
                process,
                captured,
                FINAL_SUMMARY.encode(),
                started + 35,
            )
            assert process.stdin is not None
            process.stdin.write(b"show an ordinary code fenced shell example\n")
            process.stdin.flush()
            read_until(
                process,
                captured,
                CODE_FENCE_MARKER.encode(),
                started + 40,
            )
            read_until(
                process,
                captured,
                b"\nprintf 'hello\\n'\n```",
                started + 42,
            )
            process.stdin.write(b"/exit\n")
            process.stdin.flush()
            try:
                return_code = process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError("HII CLI did not exit after /exit")
            if process.stdout is not None:
                while chunk := os.read(process.stdout.fileno(), 4096):
                    captured.extend(chunk)
            if return_code != 0:
                raise AssertionError(f"HII CLI exited {return_code}:\n{captured.decode(errors='replace')}")

            output = captured.decode("utf-8", "replace")
            assert_contains_once(output, COMMENTARY)
            assert_contains_once(output, "ok")
            assert_contains_once(output, STDERR_MARKER)
            assert_contains_once(output, SHELL_END)
            assert_contains_once(output, VERIFY_MARKER)
            assert_contains_once(output, FINAL_SUMMARY)
            assert_contains_once(output, "```sh")
            assert_contains_once(output, CODE_FENCE_MARKER)
            forbidden = (
                "welcome",
                "welcome back",
                "hii ›",
                "last run",
                "◇",
                "model.action",
                "model.request",
                "tool.output",
                "tool.result",
                "assistant.message",
                "model.delta",
                "verification:",
                '"next"',
                "[run]",
                "shell(",
            )
            lower_output = output.lower()
            for marker in forbidden:
                if marker.lower() in lower_output:
                    raise AssertionError(f"internal label, badge, welcome, or field leaked: {marker!r}\n{output}")

            requests = server.requests
            if len(requests) < 4:
                raise AssertionError(f"expected at least 4 model turns, received {len(requests)}")
            first_request = json.dumps(requests[0], ensure_ascii=False)
            for sentinel in (PROFILE_SENTINEL, LESSON_SENTINEL, AGENTS_SENTINEL):
                if sentinel in first_request:
                    raise AssertionError(f"initial model request included premature context {sentinel}")
            later_requests = json.dumps(requests[1:], ensure_ascii=False)
            if AGENTS_SENTINEL not in later_requests:
                raise AssertionError("workspace instructions were never loaded after the first action proposal")

            jsonl_files = list(runtime.rglob("*.jsonl"))
            events = [row for path in jsonl_files for row in read_jsonl(path)]
            kinds = {row.get("kind") for row in events}
            for required in ("model.request", "model.action", "tool.output"):
                if required not in kinds:
                    raise AssertionError(f"runtime ledger is missing {required}; found {sorted(map(str, kinds))}")
            stream_events = [
                row for row in events
                if row.get("kind") == "tool.output" and isinstance(row.get("data"), dict)
            ]
            streams = {
                row["data"].get("stream")
                for row in stream_events
                if row["data"].get("byteCount", 0) > 0
            }
            if not {"stdout", "stderr"}.issubset(streams):
                raise AssertionError(f"tool.output ledger lacks stdout/stderr evidence: {streams}")
            tool_results = [
                row for row in events
                if row.get("kind") == "tool.result" and isinstance(row.get("data"), dict)
            ]
            if not any(
                all(marker in str(row["data"].get("output", "")) for marker in ("ok", STDERR_MARKER, SHELL_END))
                for row in tool_results
            ):
                raise AssertionError("tool.result ledger did not preserve complete shell output")
            receipts = list(runtime.rglob("receipt.json"))
            if not receipts:
                raise AssertionError("no persisted run receipt was found")
            for receipt_path in receipts:
                json.loads(receipt_path.read_text())

            return {
                "ok": True,
                "provider": "llama.cpp (fake loopback endpoint)",
                "modelTurns": len(requests),
                "initialPromptChars": sum(
                    len(str(message.get("content", "")))
                    for message in requests[0].get("messages", [])
                    if isinstance(message, dict)
                ),
                "events": sorted(required for required in ("model.request", "model.action", "tool.output")),
                "receiptCount": len(receipts),
                "firstToolOutputMs": round((first_tool_output_at - started) * 1000),
                "shellEndMs": round((shell_end_at - started) * 1000),
                "finalSeenMs": round((final_seen_at - started) * 1000),
            "visibleOutput": ["commentary", "stdout", "stderr", "verification", "final summary", "code fence"],
            }
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def run_agent_smoke(binary: Path, *, machine: bool) -> dict[str, Any]:
    root = Path(__file__).resolve().parents[1]
    tag = "jsonl" if machine else "human"
    with tempfile.TemporaryDirectory(prefix=f"hii-cli-raw-run-{tag}-") as temporary:
        base = Path(temporary)
        home = base / "home"
        runtime = base / "runtime"
        workspace = base / "workspace"
        for directory in (home, runtime, workspace):
            directory.mkdir(parents=True, exist_ok=True)

        server = FakeModelServer(("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{server.server_address[1]}"
        env = isolated_env(root, home, runtime, endpoint)
        goal = "RAW_SMOKE_AGENT_JSONL: run a shell command" if machine else "RAW_SMOKE_AGENT_RUN: run a shell command"
        command = [
            str(binary),
            "--no-hooks",
            "--cwd",
            str(workspace),
            "--model",
            MODEL,
            "--max-steps",
            "4",
            "run",
            goal,
        ]
        if machine:
            command.append("--jsonl")
        else:
            command.append("--stream")

        try:
            if machine:
                result = subprocess.run(
                    command,
                    cwd=workspace,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=45,
                    check=False,
                )
                output = result.stdout.decode("utf-8", "replace")
                if result.returncode != 0:
                    raise AssertionError(f"human-independent run exited {result.returncode}:\n{output}")
                lines = output.splitlines()
                if not lines:
                    raise AssertionError("--jsonl produced no event lines")
                try:
                    rows = [json.loads(line) for line in lines]
                except json.JSONDecodeError as error:
                    raise AssertionError(f"--jsonl mixed non-JSON output into stdout: {error}\n{output}") from error
                packed = json.dumps(rows, ensure_ascii=False)
                for marker in ("ok", STDERR_MARKER, SHELL_END):
                    if marker not in packed:
                        raise AssertionError(f"--jsonl omitted shell result {marker!r}:\n{output}")
                return {"mode": "jsonl", "lines": len(rows), "allLinesParse": True}

            process = subprocess.Popen(
                command,
                cwd=workspace,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
            )
            captured = bytearray()
            started = time.monotonic()
            try:
                first = read_until(process, captured, b"ok\n", started + 20)
                end = read_until(process, captured, SHELL_END.encode(), started + 25)
                if end - first < 0.40:
                    raise AssertionError(
                        "native `hii run --stream` did not expose shell output before exit:\n"
                        + captured.decode("utf-8", "replace")
                    )
                rest, _ = process.communicate(timeout=20)
                captured.extend(rest)
                if process.returncode != 0:
                    raise AssertionError(f"human run exited {process.returncode}:\n{captured.decode(errors='replace')}")
            except Exception:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                raise
            output = captured.decode("utf-8", "replace")
            for marker in ("\nok\n", STDERR_MARKER, SHELL_END, AGENT_FINAL):
                assert_contains_once(output, marker)
            return {
                "mode": "human-stream",
                "firstToolOutputMs": round((first - started) * 1000),
                "shellEndMs": round((end - started) * 1000),
                "rawStdoutStderrVisible": True,
            }
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def main() -> int:
    binary_value = os.environ.get("HII_CLI_BIN")
    if not binary_value:
        print("Set HII_CLI_BIN to an already-built HII CLI binary.", file=sys.stderr)
        return 2
    binary = Path(binary_value).expanduser().resolve()
    if not binary.is_file():
        print(f"HII_CLI_BIN does not name a file: {binary}", file=sys.stderr)
        return 2
    try:
        summary = run_smoke(binary)
        summary["nativeRun"] = run_agent_smoke(binary, machine=False)
        summary["nativeRunJsonl"] = run_agent_smoke(binary, machine=True)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
