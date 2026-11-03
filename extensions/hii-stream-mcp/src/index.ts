// SPDX-License-Identifier: Apache-2.0
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

type Env = {
  HiiStreamMCP: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  LINKS_POST_TOKEN: string;
};

const COLUMNS = "id,url,title,note,tags,source,summary,created_at";

function restUrl(env: Env, path: string) {
  return `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
}

export class HiiStreamMCP extends McpAgent<Env, Record<string, never>, {}> {
  server = new McpServer({ name: "hii-stream", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "list_links",
      {
        description:
          "List recent posts from the public HII link stream at umminuriddingreen.com/stream, newest first.",
        inputSchema: { limit: z.number().int().min(1).max(100).default(20) }
      },
      async ({ limit }) => {
        const res = await fetch(
          restUrl(this.env, `link_posts?select=${COLUMNS}&order=created_at.desc&limit=${limit}`),
          {
            headers: {
              apikey: this.env.SUPABASE_ANON_KEY,
              authorization: `Bearer ${this.env.SUPABASE_ANON_KEY}`
            }
          }
        );
        if (!res.ok) throw new Error(`link_posts read failed (${res.status})`);
        return { content: [{ type: "text", text: await res.text() }] };
      }
    );

    this.server.registerTool(
      "post_link",
      {
        description:
          "Publish a link to the public HII stream at umminuriddingreen.com/stream. Use for links worth sharing publicly.",
        inputSchema: {
          url: z.string().url(),
          title: z.string().max(200).default(""),
          note: z.string().max(1000).default(""),
          tags: z.array(z.string()).max(12).default([]),
          summary: z.string().max(2000).optional(),
          source: z.string().max(40).default("mcp")
        }
      },
      async ({ url, title, note, tags, summary, source }) => {
        const res = await fetch(restUrl(this.env, `link_posts?select=${COLUMNS}`), {
          method: "POST",
          headers: {
            apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
            authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
            "content-type": "application/json",
            prefer: "return=representation"
          },
          body: JSON.stringify({ url, title, note, tags, source, summary: summary ?? null })
        });
        if (!res.ok) throw new Error(`link_posts insert failed (${res.status})`);
        return { content: [{ type: "text", text: await res.text() }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mcp")) {
      const auth = request.headers.get("authorization") ?? "";
      if (!env.LINKS_POST_TOKEN || auth !== `Bearer ${env.LINKS_POST_TOKEN}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      return HiiStreamMCP.serve("/mcp", { binding: "HiiStreamMCP" }).fetch(request, env, ctx);
    }
    return new Response("hii-stream-mcp: POST /mcp (Streamable HTTP, bearer token required)", {
      status: url.pathname === "/" ? 200 : 404
    });
  }
};
