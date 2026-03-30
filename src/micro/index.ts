import { fileSearch } from "./file_search.js";
import { fileRead } from "./file_read.js";
import { dirTree } from "./dir_tree.js";
import { codeGrep } from "./code_grep.js";
import { searchMemory } from "../store/native_memory.js";

export interface MicroTool {
  name: string;
  description: string;
  args: Record<string, string>;
  run: (args: Record<string, any>) => Promise<string>;
}

export const microTools: MicroTool[] = [
  {
    name: "file_search",
    description: "Search file contents across a directory by pattern",
    args: {
      path: "Directory to search in",
      pattern: "Search pattern (string or regex)",
      maxResults: "Max number of results (optional, default 20)",
    },
    run: async (args) => fileSearch(args.path, args.pattern, args.maxResults),
  },
  {
    name: "file_read",
    description: "Read a file and return its contents",
    args: {
      path: "Absolute path to file",
      lines: "Max lines to return (optional, default 200)",
    },
    run: async (args) => fileRead(args.path, args.lines),
  },
  {
    name: "dir_tree",
    description: "Show directory structure as ASCII tree",
    args: {
      path: "Directory path",
      depth: "Max depth to traverse (optional, default 3)",
    },
    run: async (args) => dirTree(args.path, args.depth),
  },
  {
    name: "code_grep",
    description: "Search code files for a pattern with line numbers",
    args: {
      path: "Directory to search in",
      pattern: "Pattern to search for",
      fileGlob: "File glob pattern (optional, default *.{ts,js,py,go,rs,md})",
    },
    run: async (args) => codeGrep(args.path, args.pattern, args.fileGlob),
  },
  {
    name: "memory_search",
    description: "Search past HII chat history for a query",
    args: {
      query: "Search query string",
      maxResults: "Max number of results (optional, default 10)",
    },
    run: async (args) => {
      const results = searchMemory(args.query, args.maxResults ?? 10);
      if (!results.length) return "No memory entries found.";
      return results
        .map((r) => `[${r.ts}] user: ${r.prompt.slice(0, 200)}\nassistant: ${r.answer.slice(0, 200)}`)
        .join("\n\n");
    },
  },
];

export function getMicroTool(name: string): MicroTool | undefined {
  return microTools.find((t) => t.name === name);
}

export function microToolsSystemPrompt(): string {
  const lines = microTools.map((t) => {
    const argList = Object.entries(t.args)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ");
    return `- ${t.name}: ${t.description} | args: ${argList}`;
  });
  return `Micro tools (fast native shortcuts):\n${lines.join("\n")}`;
}

export async function runMicroTool(
  name: string,
  args: Record<string, any>
): Promise<string> {
  const tool = getMicroTool(name);
  if (!tool) return `Error: unknown micro tool "${name}"`;
  try {
    return await tool.run(args);
  } catch (err: any) {
    return `Error running ${name}: ${err.message}`;
  }
}
