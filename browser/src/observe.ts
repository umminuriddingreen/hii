// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { randomUUID } from "node:crypto";
import type { Locator } from "playwright";
import { boundedText, MAX_VISIBLE_TEXT, safePublicUrl } from "./sanitize.js";
import { digest, SEMANTIC_ROLES, type PageState } from "./sessions.js";

export interface BrowserObservation {
  observationId: string;
  sessionId: string;
  pageId: string;
  url: string;
  title: string;
  revision: number;
  interactiveElements: Array<{
    elementRef: string;
    role: string;
    name: string;
    state: { enabled: boolean; visible: boolean; checked?: boolean; selected?: boolean };
  }>;
  visibleText: string;
  ariaSnapshot: string;
  navigationState: string;
  evidence: { source: string; observedAt: string; pageRevision: number; digest: string };
}

export async function refreshRevision(state: PageState): Promise<{ aria: string; text: string; title: string }> {
  const aria = boundedText(await state.page.ariaSnapshot().catch(() => ""), MAX_VISIBLE_TEXT);
  const text = boundedText(await state.page.locator("body").innerText().catch(() => ""), MAX_VISIBLE_TEXT);
  const title = boundedText(await state.page.title().catch(() => ""), 500);
  const fingerprint = digest(`${state.page.url()}\n${title}\n${aria}\n${text}`);
  if (fingerprint !== state.fingerprint) {
    state.revision += 1;
    state.fingerprint = fingerprint;
    state.refs.clear();
  }
  return { aria, text, title };
}

export async function observe(sessionId: string, state: PageState): Promise<BrowserObservation> {
  const content = await refreshRevision(state);
  state.refs.clear();
  const interactiveElements: BrowserObservation["interactiveElements"] = [];
  let refCounter = 0;
  for (const role of SEMANTIC_ROLES) {
    const locators = await state.page.getByRole(role).all();
    for (const locator of locators.slice(0, 100)) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const snapshot = await locator.ariaSnapshot().catch(() => "");
      const name = accessibleName(snapshot);
      const elementRef = `e_${++refCounter}`;
      state.refs.set(elementRef, locator);
      const item: BrowserObservation["interactiveElements"][number] = {
        elementRef,
        role,
        name,
        state: {
          enabled: await locator.isEnabled().catch(() => false),
          visible,
        },
      };
      if (role === "checkbox" || role === "radio") item.state.checked = await locator.isChecked().catch(() => false);
      if (role === "option" || role === "tab") item.state.selected = await locator.getAttribute("aria-selected").then(value => value === "true").catch(() => false);
      interactiveElements.push(item);
    }
  }
  const observedAt = new Date().toISOString();
  return {
    observationId: `obs_${randomUUID()}`,
    sessionId,
    pageId: state.id,
    url: safePublicUrl(state.page.url()),
    title: content.title,
    revision: state.revision,
    interactiveElements,
    visibleText: content.text,
    ariaSnapshot: content.aria,
    navigationState: await state.page.evaluate(() => document.readyState).catch(() => "unknown"),
    evidence: {
      source: "hii-browserd.playwright",
      observedAt,
      pageRevision: state.revision,
      digest: state.fingerprint,
    },
  };
}

function accessibleName(snapshot: string): string {
  const line = snapshot.split("\n", 1)[0]?.trim() ?? "";
  const quoted = line.match(/^-[^\"]*\"((?:[^\"\\]|\\.)*)\"/);
  if (quoted) {
    try {
      return JSON.parse(`"${quoted[1]}"`);
    } catch {
      return quoted[1];
    }
  }
  const plain = line.match(/^-[^:]+:\s*(.+)$/);
  return plain?.[1]?.trim() ?? "";
}

export async function actionable(state: PageState, ref: string): Promise<Locator> {
  const locator = state.refs.get(ref);
  if (!locator || await locator.count() !== 1) throw new Error(`unknown_element:${ref}`);
  if (!await locator.isVisible() || !await locator.isEnabled()) throw new Error(`not_actionable:${ref}`);
  return locator;
}
