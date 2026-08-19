// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { allowedBodyType, MAX_NETWORK_BODY, safePublicUrl } from "./sanitize.js";
import { ProtocolFailure } from "./protocol.js";
import type { PageState } from "./sessions.js";

export function observeNetwork(state: PageState) {
  return state.network.map(record => ({
    requestId: record.id,
    method: record.method,
    url: safePublicUrl(record.url),
    status: record.status,
    contentType: record.contentType,
    resourceType: record.resourceType,
    observedAt: record.observedAt,
  }));
}

export async function networkBody(state: PageState, requestId: string, requestedMax: number) {
  const record = state.network.find(item => item.id === requestId);
  if (!record?.response) throw new ProtocolFailure({ code: "invalid_request", message: "network response is unavailable" });
  const contentType = record.contentType ?? "";
  if (!allowedBodyType(contentType)) {
    throw new ProtocolFailure({ code: "unsupported_content_type", message: "network body content type is not allowed" });
  }
  const limit = Math.min(Math.max(requestedMax || MAX_NETWORK_BODY, 1), MAX_NETWORK_BODY);
  const body = await record.response.text();
  const bytes = Buffer.from(body);
  return {
    requestId,
    contentType,
    body: bytes.subarray(0, limit).toString("utf8"),
    truncated: bytes.byteLength > limit,
  };
}
