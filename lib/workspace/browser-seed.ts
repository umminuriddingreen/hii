// SPDX-License-Identifier: LicenseRef-BSL-1.1

import type { NodeSeed } from './ingest';
import { browserNavigationTarget } from './browser-target';

function browserTitle(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'browser';
  }
}

/** Create the shared movable browser object used by native and web canvases. */
export function renderedBrowserSeed(value: string): NodeSeed | null {
  const url = browserNavigationTarget(value);
  if (!url) return null;
  return {
    type: 'browser',
    w: 1120,
    h: 720,
    object: {
      kind: 'browser',
      owner: 'human',
      status: 'ready',
      source: url,
      capabilityId: 'hii.browser.retrieval',
      audit: [{ ts: new Date().toISOString(), actor: 'human', action: 'rendered pasted link as a browser object' }]
    },
    payload: { surface: 'native-dev-browser', title: browserTitle(url), url }
  };
}
