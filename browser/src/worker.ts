// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Dispatches typed HII browser commands to Playwright mechanics.

import * as actions from "./actions.js";
import { networkBody, observeNetwork } from "./network.js";
import { observe } from "./observe.js";
import { ProtocolFailure, requireRevision, requireString, type ProtocolRequest } from "./protocol.js";
import { boundedText, MAX_VISIBLE_TEXT, safeHttpUrl } from "./sanitize.js";
import { SessionStore } from "./sessions.js";

export class BrowserWorker {
  readonly store = new SessionStore();

  async dispatch(request: ProtocolRequest): Promise<Record<string, unknown>> {
    const params = request.params ?? {};
    switch (request.method) {
      case "web.session.open": {
        const { session, page } = await this.store.open();
        return { kind: "session_opened", sessionId: session.id, pageId: page.id };
      }
      case "web.navigate": {
        const { sessionId, page } = this.page(params);
        return actions.navigate(sessionId, page, safeHttpUrl(requireString(params, "url")));
      }
      case "web.observe": {
        const { sessionId, page } = this.page(params);
        return { kind: "observation", observation: await observe(sessionId, page) };
      }
      case "web.click": {
        const { sessionId, page } = this.page(params);
        return actions.click(sessionId, page, requireString(params, "target"), requireRevision(params));
      }
      case "web.type": {
        const { sessionId, page } = this.page(params);
        return actions.typeText(sessionId, page, requireString(params, "target"), requireString(params, "text"), requireRevision(params));
      }
      case "web.select": {
        const { sessionId, page } = this.page(params);
        return actions.select(sessionId, page, requireString(params, "target"), requireString(params, "value"), requireRevision(params));
      }
      case "web.back": {
        const { sessionId, page } = this.page(params);
        return actions.back(sessionId, page, requireRevision(params));
      }
      case "web.tabs": {
        const session = this.store.session(requireString(params, "session_id"));
        const pages = await Promise.all([...session.pages.values()].map(async page => ({
          pageId: page.id,
          url: page.page.url(),
          title: await page.page.title().catch(() => ""),
          revision: page.revision,
        })));
        return { kind: "tabs", pages };
      }
      case "web.extract": {
        const { page } = this.page(params);
        const max = typeof params.max_chars === "number" ? Math.min(params.max_chars, MAX_VISIBLE_TEXT) : MAX_VISIBLE_TEXT;
        const observation = await observe(requireString(params, "session_id"), page);
        return { kind: "extracted", text: boundedText(observation.visibleText, max), observationId: observation.observationId };
      }
      case "web.wait": {
        const { page } = this.page(params);
        const milliseconds = typeof params.milliseconds === "number" ? Math.min(Math.max(params.milliseconds, 0), 30_000) : 0;
        await page.page.waitForTimeout(milliseconds);
        return { kind: "waited" };
      }
      case "web.network.observe": {
        const { page } = this.page(params);
        return { kind: "network", requests: observeNetwork(page) };
      }
      case "web.network.body": {
        const { page } = this.page(params);
        const max = typeof params.max_bytes === "number" ? params.max_bytes : 0;
        return { kind: "network_body", ...await networkBody(page, requireString(params, "network_request_id"), max) };
      }
      default:
        throw new ProtocolFailure({ code: "capability_not_registered", message: `unregistered browser capability ${request.method}` });
    }
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private page(params: Record<string, unknown>) {
    const sessionId = requireString(params, "session_id");
    const pageId = requireString(params, "page_id");
    return { sessionId, page: this.store.page(sessionId, pageId) };
  }
}
