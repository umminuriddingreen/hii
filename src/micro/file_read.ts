import fs from "fs";

export async function fileRead(
  filePath: string,
  lines?: number
): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const limit = lines ?? 200;
    const allLines = content.split("\n");
    if (allLines.length <= limit) return content;
    return allLines.slice(0, limit).join("\n") + `\n... (truncated at ${limit} lines, total ${allLines.length})`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}
