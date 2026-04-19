import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';

const AUTH_TOKEN_FILE = path.join(os.homedir(), '.hii', 'auth_token');
export const AUTH_COOKIE_NAME = 'hii_auth';

export function loadHiiAuthToken(): string {
  const envToken = process.env.HII_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const token = fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
    if (token) return token;
  } catch {
    // Fall through and create one to match the Python control plane behavior.
  }
  fs.mkdirSync(path.dirname(AUTH_TOKEN_FILE), { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(AUTH_TOKEN_FILE, `${token}\n`, 'utf8');
  return token;
}

export function extractAuthCookie(rawCookieHeader?: string | null): string {
  const raw = rawCookieHeader?.trim();
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === AUTH_COOKIE_NAME) {
      return rest.join('=').trim();
    }
  }
  return '';
}

export function authCookieHeader(token: string): string {
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

export function dangerousSurfacesEnabled(): boolean {
  return process.env.HII_ENABLE_DANGEROUS_SURFACES === '1';
}

export function defaultServerHost(): string {
  return process.env.HII_HOST || '127.0.0.1';
}

export function getAllowedRoots(cfg: Config): string[] {
  const roots = [
    cfg.workspacePath,
    cfg.sessionsPath,
    cfg.notesPath,
    cfg.obsidianVaultPath,
  ].filter(Boolean) as string[];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function resolveAllowedPath(candidate: string, roots: string[]): string | null {
  const resolved = path.resolve(candidate);
  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)) {
      return resolved;
    }
  }
  return null;
}
