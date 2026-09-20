/**
 * Pi adapter for HII's one canonical MCP server.
 *
 * Install by linking this file into ~/.pi/agent/extensions/hii-mcp.ts.
 * It discovers the live `hii mcp` catalog and registers every advertised tool
 * with an `hii_` prefix so Pi never collides with its built-in tools.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type McpTool = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

export function normalizeParametersSchema(inputSchema: unknown): Record<string, unknown> {
	if (
		inputSchema &&
		typeof inputSchema === "object" &&
		!Array.isArray(inputSchema) &&
		(inputSchema as Record<string, unknown>).type === "object"
	) {
		return {
			additionalProperties: true,
			...(inputSchema as Record<string, unknown>),
		};
	}
	return {
		type: "object",
		properties: {},
		required: [],
		additionalProperties: true,
	};
}

async function request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
	return await new Promise((resolve, reject) => {
		const child = spawn(
			"hii",
			["mcp", "--authority", "workspace", "--client-identity", "pi"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) return reject(new Error("HII MCP call aborted"));
			if (code !== 0) return reject(new Error(stderr.trim() || `hii mcp exited ${code}`));
			const response = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((value) => value.id === 2);
			if (!response) return reject(new Error("HII MCP returned no response"));
			if (response.error) return reject(new Error(response.error.message));
			resolve(response.result);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
		child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })}\n`);
	});
}

export default async function hiiMcpExtension(pi: ExtensionAPI) {
	const catalog = await request("tools/list");
	for (const tool of (catalog.tools ?? []) as McpTool[]) {
		pi.registerTool({
			name: `hii_${tool.name}`,
			label: `HII · ${tool.name.replaceAll("_", " ")}`,
			description: tool.description ?? `Call ${tool.name} through HII MCP`,
			promptSnippet: `Use HII's governed ${tool.name} capability`,
			promptGuidelines: [
				"Use hii_canvas_list and hii_canvas_read to inspect the HII canvas before changing it.",
				"Use hii_canvas_add or hii_canvas_update only when the user asks to change the HII canvas.",
			],
			parameters: normalizeParametersSchema(tool.inputSchema) as any,
			async execute(_toolCallId, params, signal) {
				const result = await request(
					"tools/call",
					{ name: tool.name, arguments: params },
					signal,
				);
				return {
					content: result.content ?? [{ type: "text", text: JSON.stringify(result) }],
					details: result.structuredContent ?? result,
				};
			},
		});
	}
}
