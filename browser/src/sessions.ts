// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import type { BrowserSessionId, ElementRef, PageId } from "./protocol.js";

export interface NetworkRecord {
  id: string;
  method: string;
  url: string;
  status?: number;
  contentType?: string;
  resourceType: string;
  observedAt: string;
  response?: Response;
}

export interface PageState {
  id: PageId;
  page: Page;
  revision: number;
  fingerprint: string;
  refs: Map<ElementRef, Locator>;
  network: NetworkRecord[];
  networkCounter: number;
}

export interface SessionState {
  id: BrowserSessionId;
  browser: Browser;
  context: BrowserContext;
  pages: Map<PageId, PageState>;
  pageCounter: number;
}

export class SessionStore {
  readonly sessions = new Map<BrowserSessionId, SessionState>();

  async open(): Promise<{ session: SessionState; page: PageState }> {
    const browser = await chromium.launch({ headless: process.env.HII_BROWSER_HEADLESS !== "0" });
    const context = await browser.newContext();
    const session: SessionState = {
      id: `browser_${randomUUID()}`,
      browser,
      context,
      pages: new Map(),
      pageCounter: 0,
    };
    const page = this.attachPage(session, await context.newPage());
    context.on("page", next => this.attachPage(session, next));
    this.sessions.set(session.id, session);
    return { session, page };
  }

  session(id: BrowserSessionId): SessionState {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown browser session ${id}`);
    return session;
  }

  page(sessionId: BrowserSessionId, pageId: PageId): PageState {
    const page = this.session(sessionId).pages.get(pageId);
    if (!page) throw new Error(`unknown browser page ${pageId}`);
    return page;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.browser.close().catch(() => undefined)));
    this.sessions.clear();
  }

  private attachPage(session: SessionState, page: Page): PageState {
    const existing = [...session.pages.values()].find(state => state.page === page);
    if (existing) return existing;
    const state: PageState = {
      id: `page_${++session.pageCounter}`,
      page,
      revision: 0,
      fingerprint: "",
      refs: new Map(),
      network: [],
      networkCounter: 0,
    };
    page.on("request", request => {
      state.network.push({
        id: `net_${++state.networkCounter}`,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        observedAt: new Date().toISOString(),
      });
      if (state.network.length > 500) state.network.splice(0, state.network.length - 500);
    });
    page.on("response", response => {
      const request = response.request();
      const record = [...state.network].reverse().find(item => !item.response && item.url === request.url() && item.method === request.method());
      if (record) {
        record.status = response.status();
        record.contentType = response.headers()["content-type"];
        record.response = response;
      }
    });
    session.pages.set(state.id, state);
    return state;
  }
}

type SemanticRole = Parameters<Page["getByRole"]>[0];

export const SEMANTIC_ROLES: SemanticRole[] = [
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "option",
  "tab",
  "menuitem",
];

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
