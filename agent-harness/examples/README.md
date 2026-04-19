# Examples

This folder holds ready-to-use installation assets for a fresh machine.

- `codex-mcp.json` is a sample MCP server entry for Codex.
- `claude-desktop-mcp.json` is the same MCP server entry formatted for Claude Desktop.
- `hii-agent-harness.env` is a starter environment file.
- `rhino_harness_command.py` is a working Rhino-side helper script generated from the CLI.

The recommended workflow is to generate fresh copies from the CLI so the `command` field matches the local install:

```bash
hii harness harness init --agent codex --output ./examples/codex-mcp.json
hii harness harness init --agent claude --output ./examples/claude-desktop-mcp.json
hii harness rhino alias-script --output ./examples/rhino_harness_command.py
```

Also see:

- [docs/setup.md](/Users/ummi/hii-agent-harness/docs/setup.md)
- [docs/rhino-plugin-build.md](/Users/ummi/hii-agent-harness/docs/rhino-plugin-build.md)
