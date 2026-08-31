// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Polling policy for canvas application launch requests.
 *
 * This lives outside the component so the backoff is testable behavior rather
 * than a magic number buried in a `useEffect`. A performance regression here is
 * invisible in the UI — the canvas still works, it just burns a request every
 * tick in a background tab — so the guard has to be a real assertion.
 */

/** Interval between launch-request polls while the document is visible. */
export const APPLICATION_POLL_INTERVAL_MS = 4000;

export type ApplicationPollState = {
  /** The effect has been torn down. */
  cancelled: boolean;
  /** `document.hidden` — the tab is backgrounded. */
  hidden: boolean;
  /** A poll is already in flight; overlapping polls double the request rate. */
  inFlight: boolean;
};

/**
 * A poll is skipped when the effect is gone, the tab is hidden, or a previous
 * poll has not settled. Hidden tabs are the important case: without it every
 * backgrounded HII window keeps polling the launch queue forever.
 */
export function shouldSkipApplicationPoll(state: ApplicationPollState): boolean {
  return state.cancelled || state.hidden || state.inFlight;
}
