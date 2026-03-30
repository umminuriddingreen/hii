import { execSync } from "child_process";

export async function fileSearch(
  searchPath: string,
  pattern: string,
  maxResults: number = 20
): Promise<string> {
  try {
    let lines: string[];

    // Try rg first
    try {
      const out = execSync(
        `rg --json -m 1 ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`,
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
      );
      const results: string[] = [];
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "match") {
            const file = obj.data.path.text;
            const lineNo = obj.data.line_number;
            const text = obj.data.lines.text.trimEnd();
            results.push(`${file}:${lineNo}: ${text}`);
            if (results.length >= maxResults) break;
          }
        } catch {
          // skip malformed json lines
        }
      }
      return results.length > 0
        ? results.join("\n")
        : "No matches found.";
    } catch {
      // rg not available or failed, fall back to grep
    }

    // Fallback: grep -rn
    const out = execSync(
      `grep -rn ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    lines = out.split("\n").filter(Boolean).slice(0, maxResults);
    return lines.length > 0 ? lines.join("\n") : "No matches found.";
  } catch (err: any) {
    if (err.status === 1) return "No matches found.";
    return `Error: ${err.message}`;
  }
}
