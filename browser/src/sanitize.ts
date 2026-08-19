// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { ProtocolFailure } from "./protocol.js";

export const MAX_VISIBLE_TEXT = 20_000;
export const MAX_NETWORK_BODY = 262_144;

export function boundedText(value: string, limit: number): string {
  return value.replace(/\u0000/g, "").slice(0, Math.max(0, limit));
}

export function safeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProtocolFailure({ code: "invalid_request", message: "url must be absolute" });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ProtocolFailure({ code: "invalid_request", message: "url must be credential-free HTTP or HTTPS" });
  }
  return parsed.toString();
}

export function safePublicUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function allowedBodyType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.includes("application/json") || type.startsWith("text/") || type.includes("javascript") || type.includes("xml");
}
