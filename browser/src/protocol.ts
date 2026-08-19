// SPDX-License-Identifier: LicenseRef-BSL-1.1

export type RequestId = string;
export type BrowserSessionId = string;
export type PageId = string;
export type ElementRef = string;
export type PageRevision = number;

export interface ProtocolRequest {
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface ProtocolResponse {
  id: RequestId;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: BrowserError;
}

export interface BrowserError {
  code:
    | "stale_observation"
    | "unknown_element"
    | "not_actionable"
    | "capability_not_registered"
    | "awaiting_authority"
    | "unsupported_content_type"
    | "invalid_request"
    | "browser_failure"
    | "verification_failed";
  message: string;
  currentRevision?: PageRevision;
}

export class ProtocolFailure extends Error {
  constructor(readonly detail: BrowserError) {
    super(detail.message);
  }
}

export function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolFailure({ code: "invalid_request", message: `${name} must be a nonempty string` });
  }
  return value;
}

export function requireRevision(params: Record<string, unknown>): number {
  const value = params.expected_page_revision;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ProtocolFailure({ code: "invalid_request", message: "expected_page_revision must be a positive integer" });
  }
  return Number(value);
}
