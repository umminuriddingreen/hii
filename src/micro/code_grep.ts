import { execSync } from "child_process";

export async function codeGrep(
  searchPath: string,
  pattern: string,
  fileGlob: string = "*.{ts,js,py,go,rs,md}"
): Promise<string> {
  try {
    // Build --include flags from glob (handles simple brace expansion)
    const globs = expandBraceGlob(fileGlob);
    const includeFlags = globs.map((g) => `--include=${JSON.stringify(g)}`).join(" ");

    const out = execSync(
      `grep -rn ${includeFlags} ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );

    const lines = out.split("\n").filter(Boolean).slice(0, 30);
    return lines.length > 0 ? lines.join("\n") : "No matches found.";
  } catch (err: any) {
    if (err.status === 1) return "No matches found.";
    return `Error: ${err.message}`;
  }
}

function expandBraceGlob(glob: string): string[] {
  // Handle *.{ts,js,py} -> ["*.ts", "*.js", "*.py"]
  const match = glob.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!match) return [glob];
  const [, pre, inner, post] = match;
  return inner.split(",").map((ext) => `${pre}${ext.trim()}${post}`);
}
