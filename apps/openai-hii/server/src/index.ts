import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import cors from "cors";
import express from "express";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hiiRoot = path.resolve(process.env.HII_ROOT ?? path.join(appDir, "../.."));
const hiiCli = path.join(hiiRoot, "scripts/hii-cli.mjs");
const widgetPath = path.join(appDir, "dist/widget/index.html");
const widgetUri = "ui://hii/home-v1.html";
const port = Number(process.env.PORT ?? 8787);

async function hiiJson(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [hiiCli, ...args], {
    cwd: hiiRoot,
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HII_ROOT: hiiRoot },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function readHome() {
  const home = await hiiJson(["home", "--json"]);
  const [{ stdout: branch }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["-C", hiiRoot, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 4_000 }),
    execFileAsync("git", ["-C", hiiRoot, "status", "--porcelain=v1"], { timeout: 4_000 }),
  ]);
  const changes = status.split("\n").filter(Boolean);
  const identity = (home.identity ?? {}) as Record<string, unknown>;
  const workspace = (home.workspace ?? {}) as Record<string, unknown>;
  return {
    ...home,
    identity: { ...identity, repo: hiiRoot },
    workspace: {
      ...workspace,
      branch: branch.trim(),
      clean: changes.length === 0,
      changes: { total: changes.length },
      files: undefined,
    },
  };
}

function toolResult(key: string, value: unknown, message: string) {
  return {
    structuredContent: { [key]: value },
    content: [{ type: "text" as const, text: message }],
  };
}

function createServer() {
  const server = new McpServer(
    { name: "hii-openai-app", version: "0.1.0" },
    { instructions: "HII is local-first. Use read-only tools to inspect bounded work and proof coordinates. Never imply an action was taken." },
  );

  registerAppResource(server, "hii-home-widget", widgetUri, {}, async () => ({
    contents: [{
      uri: widgetUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(widgetPath, "utf8"),
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
        "openai/widgetDescription": "A compact read-only view of HII workspace state, bounded work, and the next verified coordinate.",
      },
    }],
  }));

  server.registerTool("get_hii_home", {
    title: "Get HII home",
    description: "Use this when the user wants a compact current summary of their local HII workspace, work queue, guardrails, and next coordinates.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => toolResult("home", await readHome(), "Read the current HII home projection."));

  server.registerTool("list_hii_work", {
    title: "List HII work",
    description: "Use this when the user wants to review bounded HII tasks and active local jobs without changing them.",
    inputSchema: { includeBlocked: z.boolean().optional().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ includeBlocked }) => {
    const work = await hiiJson(["work", "--json"]);
    if (!includeBlocked && Array.isArray(work.activeTasks)) {
      work.activeTasks = work.activeTasks.filter((task) => (task as { lane?: string }).lane !== "blocked");
    }
    return toolResult("work", work, "Read the current bounded HII work queue.");
  });

  registerAppTool(server, "render_hii_home", {
    title: "Show HII home",
    description: "Use this after inspecting HII state when the user would benefit from a compact visual card of workspace and work coordinates.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: widgetUri }, "openai/outputTemplate": widgetUri, "openai/toolInvocation/invoking": "Reading HII home", "openai/toolInvocation/invoked": "HII home is ready" },
  }, async () => toolResult("home", await readHome(), "Rendered the current HII home projection."));

  return server;
}

const app = express();
app.use(cors({ origin: true, exposedHeaders: ["Mcp-Session-Id"] }));
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, app: "hii-openai-app" }));
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, "127.0.0.1", () => {
  console.log(`HII OpenAI app listening on http://127.0.0.1:${port}/mcp`);
});
