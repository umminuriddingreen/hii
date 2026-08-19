// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Reserves internal Chromium depth without exposing CDP through HII semantics.

import type { BrowserContext, CDPSession, Page } from "playwright";

export async function internalCdpSession(context: BrowserContext, page: Page): Promise<CDPSession> {
  return context.newCDPSession(page);
}
