// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Ox Alpha's public chat as a browser-backed HII model transport.

import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

export interface OxAlphaBrowserRequest {
  model: string;
  prompt: string;
  timeoutMs?: number;
}

export type OxAlphaBrowserEvent =
  | { type: "status"; phase: string }
  | { type: "delta"; content: string }
  | { type: "done"; model: string }
  | { type: "error"; message: string };

export function appendedDomText(previous: string, current: string): string {
  return current.startsWith(previous) ? current.slice(previous.length) : "";
}

export async function streamOxAlphaDom(
  request: OxAlphaBrowserRequest,
  emit: (event: OxAlphaBrowserEvent) => void,
): Promise<void> {
  if (!request.prompt.trim()) throw new Error("Ox Alpha browser prompt is empty");
  const timeoutMs = Math.min(Math.max(request.timeoutMs || 300_000, 5_000), 600_000);
  const headless = process.env.HII_BROWSER_HEADLESS !== "0";
  const runtime = process.env.HII_RUNTIME_DIR || process.env.HII_HOME || path.join(os.homedir(), ".hii");
  const profile = process.env.HII_OXALPHA_BROWSER_PROFILE || path.join(runtime, "browser", "ox-alpha");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, { headless });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://oxalpha.com/chat", { waitUntil: "domcontentloaded", timeout: 30_000 });
    emit({ type: "status", phase: "page-ready" });
    await submitPrompt(page, request.prompt);
    emit({ type: "status", phase: "prompt-submitted" });
    await observeAnswer(page, request.model, timeoutMs, emit);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox").last();
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.fill(prompt);
  const send = page.getByRole("button", { name: "Send", exact: true }).last();
  await send.waitFor({ state: "visible", timeout: 10_000 });
  await send.click();
}

async function observeAnswer(
  page: Page,
  model: string,
  timeoutMs: number,
  emit: (event: OxAlphaBrowserEvent) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableTicks = 0;
  let nextHeartbeat = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (Date.now() >= nextHeartbeat) {
      emit({ type: "status", phase: previous ? "streaming" : "waiting" });
      nextHeartbeat = Date.now() + 1_000;
    }
    const verification = page.getByText("Please confirm you're human", { exact: false });
    if (await verification.isVisible({ timeout: 50 }).catch(() => false)) {
      if (process.env.HII_BROWSER_HEADLESS !== "0") {
        throw new Error(
          "Ox Alpha requires a one-time human verification. Run the same HII request once with HII_BROWSER_HEADLESS=0, complete the visible check, then later turns can stay headless in the persisted HII browser profile.",
        );
      }
      await page.waitForTimeout(100);
      continue;
    }
    const assistants = page.locator(".msg.msg-assistant");
    if (await assistants.count() === 0) {
      await page.waitForTimeout(40);
      continue;
    }
    const assistant = assistants.last();
    const error = await assistant.locator(".msg-error").innerText({ timeout: 100 }).catch(() => "");
    if (error.trim()) throw new Error(`Ox Alpha page reported: ${error.trim()}`);
    const current = await assistant.locator(".msg-content .prose").innerText({ timeout: 100 }).catch(() => "");
    const delta = appendedDomText(previous, current);
    if (delta) {
      previous = current;
      stableTicks = 0;
      emit({ type: "delta", content: delta });
    } else if (current === previous && current) {
      stableTicks += 1;
    }
    const actionsVisible = await assistant.locator(".msg-actions").isVisible({ timeout: 100 }).catch(() => false);
    if (previous && actionsVisible && stableTicks >= 1) {
      emit({ type: "done", model });
      return;
    }
    await page.waitForTimeout(40);
  }
  const visible = await page.locator("body").innerText().catch(() => "");
  throw new Error(
    `Ox Alpha browser response timed out at ${page.url()}: ${visible.replace(/\s+/g, " ").slice(0, 500)}`,
  );
}
