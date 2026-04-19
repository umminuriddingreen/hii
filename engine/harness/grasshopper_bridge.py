from __future__ import annotations

import json
import os
import socket
import time
from typing import Any

from mcp.server.fastmcp import FastMCP


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


DEFAULT_GRASSHOPPER_HOST = os.environ.get("GRASSHOPPER_MCP_HOST", "127.0.0.1")
DEFAULT_GRASSHOPPER_PORT = _env_int("GRASSHOPPER_MCP_PORT", 8080)
DEFAULT_SOCKET_TIMEOUT_S = _env_float("GRASSHOPPER_MCP_TIMEOUT_S", 15.0)
DEFAULT_CONNECT_RETRIES = _env_int("GRASSHOPPER_MCP_CONNECT_RETRIES", 1)
DEFAULT_RETRY_BACKOFF_S = _env_float("GRASSHOPPER_MCP_RETRY_BACKOFF_S", 0.25)
DEFAULT_MAX_RESPONSE_BYTES = _env_int("GRASSHOPPER_MCP_MAX_RESPONSE_BYTES", 2_000_000)
DEFAULT_CAPABILITY_CACHE_PATH = os.environ.get(
    "GRASSHOPPER_MCP_CAP_CACHE", "/tmp/grasshopper_mcp_capabilities.json"
)

RUNTIME_CONFIG: dict[str, Any] = {
    "host": DEFAULT_GRASSHOPPER_HOST,
    "port": DEFAULT_GRASSHOPPER_PORT,
    "timeout_s": DEFAULT_SOCKET_TIMEOUT_S,
    "connect_retries": DEFAULT_CONNECT_RETRIES,
    "retry_backoff_s": DEFAULT_RETRY_BACKOFF_S,
    "max_response_bytes": DEFAULT_MAX_RESPONSE_BYTES,
}

COMMAND_PROBES: dict[str, dict[str, Any]] = {
    "get_document_info": {"parameters": {}, "mutating": False},
    "get_connections": {"parameters": {}, "mutating": False},
    "search_components": {"parameters": {"query": "toggle"}, "mutating": False},
    "get_component_info": {
        "parameters": {"component_id": "00000000-0000-0000-0000-000000000000"},
        "mutating": False,
    },
    "get_component_parameters": {
        "parameters": {"component_id": "00000000-0000-0000-0000-000000000000"},
        "mutating": False,
    },
    "validate_connection": {
        "parameters": {
            "source_id": "00000000-0000-0000-0000-000000000000",
            "source_output": "A",
            "target_id": "00000000-0000-0000-0000-000000000000",
            "target_input": "A",
        },
        "mutating": False,
    },
    "save_document": {"parameters": {"file_path": "/tmp/gh_mcp_probe.gh"}, "mutating": True},
    "load_document": {"parameters": {"file_path": "/tmp/gh_mcp_probe.gh"}, "mutating": True},
    "clear_document": {"parameters": {}, "mutating": True},
    "add_component": {
        "parameters": {"component_name": "Panel", "x": 100.0, "y": 100.0, "params": {}},
        "mutating": True,
    },
    "connect_components": {
        "parameters": {
            "source_id": "00000000-0000-0000-0000-000000000000",
            "source_output": "A",
            "target_id": "00000000-0000-0000-0000-000000000000",
            "target_input": "A",
        },
        "mutating": True,
    },
}

COMMAND_CAPABILITIES: dict[str, dict[str, Any]] = {}
mcp = FastMCP("HII Grasshopper MCP Bridge")


def _current_config() -> dict[str, Any]:
    return dict(RUNTIME_CONFIG)


def _clean_text(text: str) -> str:
    return text.replace("\x00", "").lstrip("\ufeff").strip()


def _decode_json_payload(raw_text: str) -> Any:
    text = _clean_text(raw_text)
    if not text:
        raise ValueError("No data received from Grasshopper.")

    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in "{[":
            continue
        try:
            obj, _ = decoder.raw_decode(text[index:])
            return obj
        except json.JSONDecodeError:
            continue

    for line in text.splitlines():
        candidate = _clean_text(line)
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue

    raise ValueError(f"Invalid JSON from Grasshopper: {text[:2000]}")


def _read_response(sock: socket.socket, timeout_s: float, max_response_bytes: int) -> Any:
    buffer = bytearray()
    deadline = time.monotonic() + timeout_s

    while len(buffer) < max_response_bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        sock.settimeout(remaining)
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            break
        if not chunk:
            break
        buffer.extend(chunk)
        try:
            return _decode_json_payload(buffer.decode("utf-8", errors="replace"))
        except ValueError:
            continue

    if not buffer:
        raise TimeoutError("Timed out waiting for data from Grasshopper.")
    if len(buffer) >= max_response_bytes:
        raise ValueError(f"Response exceeded max size ({max_response_bytes} bytes).")
    return _decode_json_payload(buffer.decode("utf-8", errors="replace"))


def _normalize_response(request_type: str, parameters: dict[str, Any], payload: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"request": {"type": request_type, "parameters": parameters}}
    if isinstance(payload, dict):
        normalized = dict(payload)
        normalized.update(base)
        if isinstance(payload.get("success"), bool):
            if payload.get("success") is False:
                error_value = payload.get("error")
                if isinstance(error_value, str):
                    if error_value.startswith("No handler registered for command type "):
                        unsupported = error_value.split("No handler registered for command type ", 1)[-1].strip().strip("'\"")
                        normalized["error_type"] = "unsupported_command"
                        normalized["unsupported_command"] = unsupported or request_type
                        normalized["hint"] = (
                            "Your GH_MCP component version does not implement this request. "
                            "Use a supported command or upgrade the Grasshopper plugin."
                        )
                    elif "Parameter must be a Guid" in error_value:
                        normalized["error_type"] = "invalid_guid"
                    else:
                        normalized["error_type"] = "plugin_error"
                elif isinstance(error_value, dict):
                    normalized["error_type"] = str(error_value.get("type", "plugin_error"))
                else:
                    normalized["error_type"] = "plugin_error"
            return normalized
        return {"success": True, "data": payload, **base}
    return {"success": True, "data": payload, **base}


def _error_response(request_type: str, parameters: dict[str, Any], kind: str, message: str, attempts: int) -> dict[str, Any]:
    return {
        "success": False,
        "request": {"type": request_type, "parameters": parameters},
        "error": {"type": kind, "message": message},
        "attempts": attempts,
    }


def _classify_support(response: dict[str, Any]) -> dict[str, Any]:
    if response.get("success"):
        return {"status": "supported", "reason": "request_succeeded"}
    if response.get("error_type") == "unsupported_command":
        return {
            "status": "unsupported",
            "reason": "unsupported_command",
            "unsupported_command": response.get("unsupported_command"),
        }
    return {"status": "supported", "reason": "handler_responded_with_error"}


def _load_capability_cache() -> None:
    try:
        with open(DEFAULT_CAPABILITY_CACHE_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return
    except Exception:
        return
    if not isinstance(data, dict):
        return
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, dict):
            COMMAND_CAPABILITIES[key] = value


def _save_capability_cache() -> None:
    try:
        with open(DEFAULT_CAPABILITY_CACHE_PATH, "w", encoding="utf-8") as handle:
            json.dump(COMMAND_CAPABILITIES, handle, indent=2, sort_keys=True)
    except Exception:
        pass


def _update_capability(command_type: str, response: dict[str, Any]) -> None:
    if not command_type:
        return
    support = _classify_support(response)
    COMMAND_CAPABILITIES[command_type] = {
        "status": support.get("status", "unknown"),
        "reason": support.get("reason"),
        "last_error": response.get("error"),
    }
    _save_capability_cache()


def _send_to_grasshopper(
    req_type: str,
    parameters: dict[str, Any] | None = None,
    *,
    host: str | None = None,
    port: int | None = None,
    timeout_s: float | None = None,
    connect_retries: int | None = None,
    retry_backoff_s: float | None = None,
    max_response_bytes: int | None = None,
) -> dict[str, Any]:
    payload_parameters = parameters or {}
    config = _current_config()
    use_host = host or str(config["host"])
    use_port = int(port if port is not None else config["port"])
    use_timeout = float(timeout_s if timeout_s is not None else config["timeout_s"])
    use_retries = max(0, int(connect_retries if connect_retries is not None else config["connect_retries"]))
    use_backoff = max(0.0, float(retry_backoff_s if retry_backoff_s is not None else config["retry_backoff_s"]))
    use_max_bytes = max(1024, int(max_response_bytes if max_response_bytes is not None else config["max_response_bytes"]))

    payload = {"type": req_type, "parameters": payload_parameters}
    data = (json.dumps(payload) + "\n").encode("utf-8")
    attempts = 0

    while attempts <= use_retries:
        attempts += 1
        stage = "connect"
        try:
            with socket.create_connection((use_host, use_port), timeout=use_timeout) as sock:
                stage = "send"
                sock.settimeout(use_timeout)
                sock.sendall(data)
                stage = "receive"
                response_payload = _read_response(sock, timeout_s=use_timeout, max_response_bytes=use_max_bytes)
            normalized = _normalize_response(req_type, payload_parameters, response_payload)
            _update_capability(req_type, normalized)
            return normalized
        except ConnectionRefusedError:
            message = (
                f"Connection refused to {use_host}:{use_port}. "
                "Ensure Rhino/Grasshopper is running and the GH_MCP component is on the canvas."
            )
            if attempts <= use_retries:
                time.sleep(use_backoff * attempts)
                continue
            return _error_response(req_type, payload_parameters, "connection_refused", message, attempts)
        except TimeoutError as exc:
            return _error_response(req_type, payload_parameters, "timeout", str(exc), attempts)
        except ValueError as exc:
            return _error_response(req_type, payload_parameters, "invalid_json", str(exc), attempts)
        except OSError as exc:
            message = f"Socket error talking to Grasshopper at {use_host}:{use_port}: {exc}"
            if stage == "connect" and attempts <= use_retries:
                time.sleep(use_backoff * attempts)
                continue
            return _error_response(req_type, payload_parameters, "socket_error", message, attempts)
    return _error_response(req_type, payload_parameters, "internal_error", "Unexpected bridge state.", attempts)


@mcp.tool()
def grasshopper_request(request_type: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send an arbitrary request to the Grasshopper MCP component."""
    return _send_to_grasshopper(request_type, parameters)


@mcp.tool()
def supported_commands(
    active_probe: bool = False,
    include_mutating: bool = False,
    commands: list[str] | None = None,
) -> dict[str, Any]:
    """Return cached or probed support data for known Grasshopper commands."""
    _load_capability_cache()
    if not active_probe:
        unsupported = sorted([key for key, value in COMMAND_CAPABILITIES.items() if value.get("status") == "unsupported"])
        supported = sorted([key for key, value in COMMAND_CAPABILITIES.items() if value.get("status") == "supported"])
        unknown = sorted([key for key in COMMAND_PROBES if key not in COMMAND_CAPABILITIES])
        return {
            "success": True,
            "active_probe": False,
            "cache_path": DEFAULT_CAPABILITY_CACHE_PATH,
            "supported": supported,
            "unsupported": unsupported,
            "unknown": unknown,
            "capabilities": COMMAND_CAPABILITIES,
        }

    targets = commands or sorted(COMMAND_PROBES)
    results: list[dict[str, Any]] = []
    for command in targets:
        probe = COMMAND_PROBES.get(command)
        if probe is None:
            results.append({"command": command, "status": "unknown", "reason": "no_probe_spec"})
            continue
        if bool(probe.get("mutating")) and not include_mutating:
            results.append({"command": command, "status": "skipped", "reason": "mutating_probe_disabled"})
            continue
        response = _send_to_grasshopper(command, dict(probe.get("parameters", {})))
        support = _classify_support(response)
        results.append(
            {
                "command": command,
                "status": support.get("status"),
                "reason": support.get("reason"),
                "error": response.get("error"),
            }
        )

    return {
        "success": True,
        "active_probe": True,
        "cache_path": DEFAULT_CAPABILITY_CACHE_PATH,
        "supported": sorted([item["command"] for item in results if item.get("status") == "supported"]),
        "unsupported": sorted([item["command"] for item in results if item.get("status") == "unsupported"]),
        "skipped": sorted([item["command"] for item in results if item.get("status") == "skipped"]),
        "unknown": sorted([item["command"] for item in results if item.get("status") == "unknown"]),
        "results": results,
        "capabilities": COMMAND_CAPABILITIES,
    }


@mcp.tool()
def bridge_config() -> dict[str, Any]:
    """Get current bridge runtime configuration."""
    return {"success": True, "config": _current_config(), "cache_path": DEFAULT_CAPABILITY_CACHE_PATH}


@mcp.tool()
def set_bridge_config(
    host: str | None = None,
    port: int | None = None,
    timeout_s: float | None = None,
    connect_retries: int | None = None,
    retry_backoff_s: float | None = None,
    max_response_bytes: int | None = None,
) -> dict[str, Any]:
    """Update bridge runtime configuration without restarting."""
    if host:
        RUNTIME_CONFIG["host"] = host
    if port is not None:
        RUNTIME_CONFIG["port"] = int(port)
    if timeout_s is not None:
        RUNTIME_CONFIG["timeout_s"] = float(timeout_s)
    if connect_retries is not None:
        RUNTIME_CONFIG["connect_retries"] = max(0, int(connect_retries))
    if retry_backoff_s is not None:
        RUNTIME_CONFIG["retry_backoff_s"] = max(0.0, float(retry_backoff_s))
    if max_response_bytes is not None:
        RUNTIME_CONFIG["max_response_bytes"] = max(1024, int(max_response_bytes))
    return {"success": True, "config": _current_config()}


@mcp.tool()
def health_check() -> dict[str, Any]:
    """Check bridge -> Grasshopper connectivity and document metadata."""
    result = _send_to_grasshopper("get_document_info")
    if result.get("success"):
        return {
            "success": True,
            "reachable": True,
            "config": _current_config(),
            "document": result.get("data"),
        }
    return {
        "success": False,
        "reachable": False,
        "config": _current_config(),
        "error": result.get("error") or result.get("message"),
        "details": result,
    }


@mcp.tool()
def clear_document() -> dict[str, Any]:
    return _send_to_grasshopper("clear_document")


@mcp.tool()
def save_document(file_path: str) -> dict[str, Any]:
    return _send_to_grasshopper("save_document", {"file_path": file_path})


@mcp.tool()
def load_document(file_path: str) -> dict[str, Any]:
    return _send_to_grasshopper("load_document", {"file_path": file_path})


@mcp.tool()
def get_document_info() -> dict[str, Any]:
    return _send_to_grasshopper("get_document_info")


@mcp.tool()
def get_connections() -> dict[str, Any]:
    return _send_to_grasshopper("get_connections")


@mcp.tool()
def list_components(name_contains: str | None = None, type_contains: str | None = None) -> dict[str, Any]:
    """List document components with optional name/type filters."""
    result = _send_to_grasshopper("get_document_info")
    if not result.get("success"):
        return result
    data = result.get("data")
    if not isinstance(data, dict):
        return {"success": False, "error": {"type": "invalid_document_data", "message": "Document info payload is not an object."}}
    components = data.get("components", [])
    if not isinstance(components, list):
        return {"success": False, "error": {"type": "invalid_document_data", "message": "Document components payload is not a list."}}

    filtered = []
    for item in components:
        if not isinstance(item, dict):
            continue
        comp_name = str(item.get("name", ""))
        comp_type = str(item.get("type", ""))
        if name_contains and name_contains.lower() not in comp_name.lower():
            continue
        if type_contains and type_contains.lower() not in comp_type.lower():
            continue
        filtered.append(item)
    return {"success": True, "count": len(filtered), "components": filtered, "source_count": len(components)}


@mcp.tool()
def get_component_info(component_id: str) -> dict[str, Any]:
    return _send_to_grasshopper("get_component_info", {"component_id": component_id})


@mcp.tool()
def get_component_parameters(component_id: str) -> dict[str, Any]:
    return _send_to_grasshopper("get_component_parameters", {"component_id": component_id})


@mcp.tool()
def validate_connection(source_id: str, source_output: str, target_id: str, target_input: str) -> dict[str, Any]:
    return _send_to_grasshopper(
        "validate_connection",
        {
            "source_id": source_id,
            "source_output": source_output,
            "target_id": target_id,
            "target_input": target_input,
        },
    )


@mcp.tool()
def add_component(component_name: str, x: float = 100.0, y: float = 100.0, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return _send_to_grasshopper("add_component", {"component_name": component_name, "x": x, "y": y, "params": params or {}})


@mcp.tool()
def connect_components(source_id: str, source_output: str, target_id: str, target_input: str) -> dict[str, Any]:
    return _send_to_grasshopper(
        "connect_components",
        {
            "source_id": source_id,
            "source_output": source_output,
            "target_id": target_id,
            "target_input": target_input,
        },
    )


@mcp.tool()
def connect_components_checked(source_id: str, source_output: str, target_id: str, target_input: str) -> dict[str, Any]:
    """Validate a connection first, then connect only if valid."""
    validation = validate_connection(source_id, source_output, target_id, target_input)
    if not validation.get("success"):
        return {"success": False, "validation": validation}
    validation_data = validation.get("data")
    is_valid = True
    if isinstance(validation_data, dict) and "isValid" in validation_data:
        is_valid = bool(validation_data["isValid"])
    if isinstance(validation_data, dict) and "valid" in validation_data:
        is_valid = bool(validation_data["valid"])
    if not is_valid:
        return {"success": False, "validation": validation, "message": "Connection validation failed."}
    connection = connect_components(source_id, source_output, target_id, target_input)
    return {"success": bool(connection.get("success")), "validation": validation, "connection": connection}


@mcp.tool()
def search_components(query: str) -> dict[str, Any]:
    return _send_to_grasshopper("search_components", {"query": query})


@mcp.tool()
def batch_requests(requests: list[dict[str, Any]], continue_on_error: bool = False) -> dict[str, Any]:
    """Execute multiple Grasshopper requests in order."""
    results = []
    success_count = 0
    failure_count = 0
    for index, item in enumerate(requests):
        if not isinstance(item, dict):
            return {"success": False, "error": {"type": "invalid_request", "message": f"requests[{index}] is not an object."}, "results": results}
        req_type = item.get("type")
        params = item.get("parameters", {})
        if not isinstance(req_type, str) or not req_type.strip():
            return {"success": False, "error": {"type": "invalid_request", "message": f"requests[{index}].type must be a non-empty string."}, "results": results}
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return {"success": False, "error": {"type": "invalid_request", "message": f"requests[{index}].parameters must be an object."}, "results": results}
        response = _send_to_grasshopper(req_type, params)
        results.append({"index": index, "request": {"type": req_type, "parameters": params}, "response": response})
        if response.get("success"):
            success_count += 1
        else:
            failure_count += 1
            if not continue_on_error:
                return {
                    "success": False,
                    "results": results,
                    "failed_index": index,
                    "summary": {"total": len(results), "success": success_count, "failed": failure_count},
                }
    return {
        "success": failure_count == 0,
        "results": results,
        "count": len(results),
        "summary": {"total": len(results), "success": success_count, "failed": failure_count},
    }


def _extract_component_id(response: dict[str, Any]) -> str | None:
    data = response.get("data")
    if not isinstance(data, dict):
        return None
    for key in ("id", "component_id", "componentId"):
        value = data.get(key)
        if value:
            return str(value)
    return None


@mcp.tool()
def create_component_chain(components: list[dict[str, Any]], connections: list[dict[str, Any]]) -> dict[str, Any]:
    """Create components, then connect them by alias or explicit IDs."""
    alias_to_id: dict[str, str] = {}
    created = []
    for index, component in enumerate(components):
        if not isinstance(component, dict):
            return {"success": False, "error": {"type": "invalid_component", "message": f"components[{index}] is not an object."}}
        name = component.get("component_name")
        if not isinstance(name, str) or not name.strip():
            return {"success": False, "error": {"type": "invalid_component", "message": f"components[{index}].component_name is required."}}
        x = float(component.get("x", 100.0))
        y = float(component.get("y", 100.0))
        params = component.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return {"success": False, "error": {"type": "invalid_component", "message": f"components[{index}].params must be an object."}}
        add_result = add_component(name, x=x, y=y, params=params)
        created_item = {"index": index, "component_name": name, "result": add_result}
        created.append(created_item)
        if not add_result.get("success"):
            return {"success": False, "created": created, "connections": [], "failed_stage": "add_component"}
        comp_id = _extract_component_id(add_result)
        alias = component.get("alias")
        if comp_id and isinstance(alias, str) and alias.strip():
            alias_to_id[alias] = comp_id
            created_item["component_id"] = comp_id

    connection_results = []
    for index, connection in enumerate(connections):
        if not isinstance(connection, dict):
            return {
                "success": False,
                "created": created,
                "connections": connection_results,
                "error": {"type": "invalid_connection", "message": f"connections[{index}] is not an object."},
            }
        source_id = str(alias_to_id.get(str(connection.get("source")), connection.get("source_id", connection.get("source", ""))))
        target_id = str(alias_to_id.get(str(connection.get("target")), connection.get("target_id", connection.get("target", ""))))
        source_output = connection.get("source_output")
        target_input = connection.get("target_input")
        if not source_id or not target_id:
            return {
                "success": False,
                "created": created,
                "connections": connection_results,
                "error": {"type": "invalid_connection", "message": f"connections[{index}] missing source/target id or alias."},
            }
        if not isinstance(source_output, str) or not isinstance(target_input, str):
            return {
                "success": False,
                "created": created,
                "connections": connection_results,
                "error": {"type": "invalid_connection", "message": f"connections[{index}] requires source_output and target_input strings."},
            }
        connect_result = connect_components_checked(source_id, source_output, target_id, target_input)
        connection_results.append(
            {
                "index": index,
                "source_id": source_id,
                "source_output": source_output,
                "target_id": target_id,
                "target_input": target_input,
                "result": connect_result,
            }
        )
        if not connect_result.get("success"):
            return {"success": False, "created": created, "connections": connection_results, "failed_stage": "connect_components"}
    return {"success": True, "created": created, "connections": connection_results}


def main() -> None:
    _load_capability_cache()
    mcp.run()
