# HII for ChatGPT

HII's private ChatGPT connector is a read-only, tool-only MCP app at
`https://humaninformationinterface.com/mcp`. It lets ChatGPT search and fetch
only the account workspaces the signed-in HII user can already access.

## Boundary

- OAuth 2.1 authorization code flow with PKCE S256 and revocable bearer tokens.
- Account identity comes from the OAuth token, never model-supplied arguments.
- `get_profile`, standard `search`, and standard `fetch` are read-only.
- No shell, local filesystem, terminal, browser history, private local database,
  publishing, payment, or remote-control access.
- The Chrome companion can optionally place an explicitly saved source into a
  writable account workspace. That checkbox is off by default.

## Local development server

```bash
cd /Users/ummi/hii/apps/openai-hii
npm install
npm run build
npm start
```

The Node server listens on `http://127.0.0.1:8787/mcp`; it is a local UI and
CLI-contract prototype, not the production account connector. Override the repo
or port with `HII_ROOT` and `PORT`.

## Connect to ChatGPT

1. In ChatGPT, enable Developer Mode under **Settings → Apps & Connectors → Advanced settings**.
2. Create an app using `https://humaninformationinterface.com/mcp`.
3. Sign in to HII with your passkey and approve the displayed read-only scope.
4. Refresh the app after changing tools or resource metadata.

This is intended for a private Developer Mode connection. It is not a public
directory submission.

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
