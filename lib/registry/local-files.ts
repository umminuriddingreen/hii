import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function readTextIfExists(filePath: string): string | null {
  if (!fileExists(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

export function redactPath(input: string): string {
  return input.replace(os.homedir(), "~");
}
