# HII for ChatGPT

A private, read-only ChatGPT app for seeing the current HII home, bounded work,
and next verified coordinate. It uses HII's CLI-owned JSON contracts rather
than creating another state store or execution authority.

## Boundary

- Reads `hii home --json` and `hii work --json` through `scripts/hii-cli.mjs`.
- Exposes no shell, filesystem, write, publish, payment, or remote-control tool.
- Returns local HII context to the connected ChatGPT app. Only connect this MCP
  endpoint to a ChatGPT account/workspace you trust with that context.

## Run locally

```bash
cd /Users/ummi/hii-newest/apps/openai-hii
npm install
npm run build
npm start
```

The server listens on `http://127.0.0.1:8787/mcp`; health is available at
`http://127.0.0.1:8787/health`. Override the repo or port with `HII_ROOT` and
`PORT`.

## Connect to ChatGPT

1. Expose port `8787` through a trusted public HTTPS tunnel.
2. In ChatGPT, enable Developer Mode under **Settings → Apps & Connectors → Advanced settings**.
3. Create an app using `https://YOUR-TUNNEL.example/mcp`.
4. Refresh the app after changing tools or resource metadata.

For a stable deployment, use authenticated private infrastructure rather than
an unauthenticated tunnel. This prototype is not prepared for public directory
submission.

## Checks

```bash
npm run check
npm run build
```

Then use MCP Inspector with Streamable HTTP at
`http://127.0.0.1:8787/mcp` to inspect and call all three tools.

## Official references

- https://developers.openai.com/apps-sdk/quickstart/
- https://developers.openai.com/apps-sdk/build/mcp-server/
- https://developers.openai.com/apps-sdk/build/chatgpt-ui/
- https://developers.openai.com/apps-sdk/plan/tools/
- https://developers.openai.com/apps-sdk/reference/
