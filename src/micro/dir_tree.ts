import fs from "fs";
import path from "path";

const SKIP = new Set(["node_modules", ".git", "dist", ".next", "__pycache__"]);

function buildTree(dirPath: string, depth: number, maxDepth: number, prefix: string): string {
  if (depth > maxDepth) return "";
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath).filter((e) => !SKIP.has(e)).sort();
  } catch {
    return "";
  }

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const last = i === entries.length - 1;
    const connector = last ? "└── " : "├── ";
    const childPrefix = last ? "    " : "│   ";
    lines.push(prefix + connector + entry);

    const fullPath = path.join(dirPath, entry);
    try {
      if (fs.statSync(fullPath).isDirectory()) {
        const sub = buildTree(fullPath, depth + 1, maxDepth, prefix + childPrefix);
        if (sub) lines.push(sub);
      }
    } catch {
      // skip unreadable
    }
  }
  return lines.join("\n");
}

export async function dirTree(dirPath: string, depth: number = 3): Promise<string> {
  try {
    fs.accessSync(dirPath);
  } catch {
    return `Error: path not found: ${dirPath}`;
  }
  const header = path.basename(dirPath) + "/";
  const body = buildTree(dirPath, 1, depth, "");
  return body ? `${header}\n${body}` : header;
}
