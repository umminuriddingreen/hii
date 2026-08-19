// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { randomUUID } from "node:crypto";
import { actionable, observe, refreshRevision } from "./observe.js";
import { ProtocolFailure, type BrowserError } from "./protocol.js";
import { digest, type PageState } from "./sessions.js";

export async function enforceRevision(state: PageState, expected: number): Promise<void> {
  await refreshRevision(state);
  if (state.revision !== expected) {
    throw new ProtocolFailure({
      code: "stale_observation",
      message: "page changed after the proposed observation",
      currentRevision: state.revision,
    });
  }
}

export async function click(sessionId: string, state: PageState, target: string, expected: number) {
  await enforceRevision(state, expected);
  let locator;
  try {
    locator = await actionable(state, target);
  } catch (error) {
    throw locatorFailure(error);
  }
  await locator.click();
  await state.page.waitForLoadState("domcontentloaded").catch(() => undefined);
  const observation = await observe(sessionId, state);
  return actionResult("web.click", state, target, expected, observation);
}

export async function typeText(sessionId: string, state: PageState, target: string, text: string, expected: number) {
  await enforceRevision(state, expected);
  let locator;
  try {
    locator = await actionable(state, target);
  } catch (error) {
    throw locatorFailure(error);
  }
  await locator.fill(text.slice(0, 20_000));
  const observation = await observe(sessionId, state);
  return actionResult("web.type", state, target, expected, observation);
}

export async function select(sessionId: string, state: PageState, target: string, value: string, expected: number) {
  await enforceRevision(state, expected);
  let locator;
  try {
    locator = await actionable(state, target);
  } catch (error) {
    throw locatorFailure(error);
  }
  await locator.selectOption(value.slice(0, 1_000));
  const observation = await observe(sessionId, state);
  return actionResult("web.select", state, target, expected, observation);
}

export async function back(sessionId: string, state: PageState, expected: number) {
  await enforceRevision(state, expected);
  await state.page.goBack({ waitUntil: "domcontentloaded" });
  const observation = await observe(sessionId, state);
  return actionResult("web.back", state, undefined, expected, observation);
}

export async function navigate(sessionId: string, state: PageState, url: string) {
  const expected = state.revision;
  await state.page.goto(url, { waitUntil: "domcontentloaded" });
  const observation = await observe(sessionId, state);
  return actionResult("web.navigate", state, undefined, expected, observation);
}

function actionResult(capabilityId: string, state: PageState, target: string | undefined, expected: number, observation: Awaited<ReturnType<typeof observe>>) {
  const observedAt = new Date().toISOString();
  return {
    kind: "action",
    evidence: {
      actionId: `action_${randomUUID()}`,
      capabilityId,
      pageId: state.id,
      expectedPageRevision: expected,
      resultingPageRevision: observation.revision,
      target,
      mechanicalSuccess: true,
      observedAt,
      digest: digest(`${capabilityId}\n${state.id}\n${expected}\n${observation.revision}\n${target ?? ""}`),
    },
    observation,
  };
}

function locatorFailure(error: unknown): ProtocolFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code: BrowserError["code"] = message.startsWith("unknown_element") ? "unknown_element" : "not_actionable";
  return new ProtocolFailure({ code, message });
}
