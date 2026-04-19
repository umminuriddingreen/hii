# Rhino And Grasshopper Plugin Build Notes

The unified harness still depends on Rhino-side components. This repository provides the portable bridge and setup assets, but the actual Rhino and Grasshopper plugins must already be installed or built on the target machine.

## Known working artifacts found on this machine

- `rhinomcp` Rhino package:
  - `/Users/ummi/Library/Application Support/McNeel/Rhinoceros/packages/8.0/rhinomcp/0.2.1/net8.0/rhinomcp.rhp`
- `GH_MCP.gha` Grasshopper component:
  - `/Users/ummi/Library/Application Support/McNeel/Rhinoceros/8.0/Plug-ins/Grasshopper (b45a29b1-4343-4035-989e-044e8580d9cf)/Libraries/GH_MCP.gha`

Use those as reference artifacts when you prepare another system.

## Required pieces

- `rhinomcp` if you also want direct Rhino MCP access outside the Grasshopper socket bridge
- `GH_MCP.gha` for the Grasshopper TCP listener used by `hii-agent-harness grasshopper-mcp`

## Target install locations

macOS:

- Rhino packages: `~/Library/Application Support/McNeel/Rhinoceros/packages/8.0/`
- Grasshopper libraries: `~/Library/Application Support/McNeel/Rhinoceros/8.0/Plug-ins/Grasshopper (b45a29b1-4343-4035-989e-044e8580d9cf)/Libraries/`

Windows:

- Rhino packages: `%APPDATA%\McNeel\Rhinoceros\packages\8.0\`
- Grasshopper libraries: `%APPDATA%\Grasshopper\Libraries\`

## If you have source

Build the plugin with the Rhino 8 and Grasshopper SDK toolchain used by the upstream project, then copy the compiled output into Rhino's package or Grasshopper library folder.

Important checks:

- The output is a valid `.rhp` or `.gha` plugin.
- Rhino can see the plugin after restart.
- The Grasshopper component can be placed on the canvas.
- The component listens on the host and port configured in the harness.

For Grasshopper specifically, the component should support the request types used by the bridge:

- `get_document_info`
- `get_connections`
- `search_components`
- `get_component_info`
- `get_component_parameters`
- `validate_connection`
- `add_component`
- `connect_components`
- `save_document`
- `load_document`
- `clear_document`

## If you only have binaries

1. Copy `rhinomcp.rhp` or install the `rhinomcp` package through Rhino/Yak.
2. Copy `GH_MCP.gha` into the Grasshopper libraries directory.
3. Restart Rhino.
4. Open Grasshopper and confirm the component appears.
5. Place the `GH_MCP` component on the canvas so it starts its TCP listener.
6. Match `GRASSHOPPER_MCP_HOST` (default `127.0.0.1`) and `GRASSHOPPER_MCP_PORT` (default `8080`) to the component settings.

The bridge also honors these optional env vars (see [setup.md](./setup.md) and the [README](../README.md) for the full list):

- `GRASSHOPPER_MCP_TIMEOUT_S`
- `GRASSHOPPER_MCP_CONNECT_RETRIES`
- `GRASSHOPPER_MCP_RETRY_BACKOFF_S`
- `GRASSHOPPER_MCP_MAX_RESPONSE_BYTES`
- `GRASSHOPPER_MCP_CAP_CACHE` (defaults to `/tmp/grasshopper_mcp_capabilities.json`)

## Vendored plugin binaries

This repo now ships the plugin binaries under `vendor/rhino/`:

```text
hii-agent-harness/
  vendor/
    rhino/
      rhinomcp/
        manifest.txt
        0.2.0/…
        0.2.1/net8.0/rhinomcp.rhp
      grasshopper/
        GH_MCP.gha
```

To install on a fresh machine, copy:

- `vendor/rhino/rhinomcp/` → `~/Library/Application Support/McNeel/Rhinoceros/packages/8.0/rhinomcp/` (macOS) or `%APPDATA%\McNeel\Rhinoceros\packages\8.0\rhinomcp\` (Windows)
- `vendor/rhino/grasshopper/GH_MCP.gha` → the Grasshopper libraries folder listed above

See [CENTRALIZATION_LOG.md](../CENTRALIZATION_LOG.md) for where these came from and the rest of the imported assets.

## Suggested verification

```bash
hii-agent-harness doctor
hii-agent-harness grasshopper-mcp
```

Then, from Codex or Claude, call the bridge `health_check` tool. To discover which commands the loaded `GH_MCP` build actually implements, call `supported_commands` with `active_probe=true`; results are cached to `GRASSHOPPER_MCP_CAP_CACHE` so later sessions can read capabilities without re-probing.

If the bridge cannot connect, the usual causes are:

- Rhino is not running.
- The `GH_MCP` component is not on the canvas.
- The component port does not match `GRASSHOPPER_MCP_PORT`.
- A firewall or local permissions issue is blocking loopback TCP.
