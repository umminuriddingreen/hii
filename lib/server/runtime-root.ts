// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * Where HII keeps its runtime state, resolved the same way in every language.
 *
 * The Rust half already gets this right: `hii_core::runtime_root()` reads
 * `HII_RUNTIME_DIR` and otherwise falls back to `dirs::home_dir()`. Several
 * TypeScript callers instead used `process.env.HOME || '.'` (or `process.cwd()`),
 * and `HOME` is normally unset on Windows -- so the two halves of the app
 * silently disagreed about where the workspace lives and the Node side wrote a
 * stray `.hii` into whatever directory it happened to start in.
 *
 * `os.homedir()` is the portable answer (it reads `USERPROFILE` on Windows), so
 * it is the fallback here and `HOME` is only an override for callers that
 * deliberately set it.
 */

import os from 'os';
import path from 'path';

/** The `~/.hii` runtime root, honoring `HII_RUNTIME_DIR`. */
export function runtimeRoot() {
  const override = process.env.HII_RUNTIME_DIR;
  if (override) return override;
  return path.join(homeDirectory(), '.hii');
}

/** The user's home directory, portable across macOS, Linux, and Windows. */
export function homeDirectory() {
  return process.env.HOME || os.homedir() || '.';
}
