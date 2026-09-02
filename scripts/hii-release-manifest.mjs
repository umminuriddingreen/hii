// SPDX-License-Identifier: LicenseRef-BSL-1.1

/**
 * The two manifests a published HII release needs, in one place.
 *
 * These had drifted apart. `hii-macos-release.mjs` wrote a `release.json`,
 * while the Worker's `download_desktop` reads `releases/latest-<platform>.json`
 * and requires a `filename` key (`workers/public-site/src/lib.rs`) -- so nothing
 * the release script produced could ever be served. And `latest.json`, which the
 * Tauri updater polls, only ever carried `darwin-*` keys, so a Windows install
 * could never see an update.
 *
 * Both platforms now contribute to the same pair of documents through here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/** Filenames the Worker will serve: it rejects anything outside this charset. */
export const SERVABLE_FILENAME = /^[A-Za-z0-9._-]+$/;

export const DOWNLOAD_ORIGIN = 'https://humaninformationinterface.com';

export function fileFacts(file) {
  return {
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
  };
}

/**
 * The document `GET /download/<platform>` reads to find and verify an artifact.
 * `filename` is the contract: the Worker refuses a manifest without it.
 */
export function downloadManifest({
  platform,
  version,
  filename,
  architecture,
  minimumSystemVersion,
  gitCommit,
  signed,
  notarized,
  bytes,
  sha256,
  publishedAt = new Date().toISOString()
}) {
  if (!SERVABLE_FILENAME.test(filename)) {
    throw new Error(`Release filename is not servable by the worker: ${filename}`);
  }
  return {
    version,
    platform,
    architecture,
    filename,
    minimumSystemVersion,
    bytes,
    sha256,
    gitCommit,
    signed,
    notarized,
    createdAt: publishedAt
  };
}

/**
 * The Tauri updater feed. Platform keys use Tauri's target triples.
 *
 * `existing` lets one platform's build add its entry without discarding the
 * other's -- the feed is a single file covering every platform, so a Windows
 * publish must merge into whatever macOS last wrote rather than replace it.
 */
export function updaterFeed({ version, platforms, publishedAt = new Date().toISOString() }, existing = null) {
  const merged = { ...(existing?.version === version ? existing.platforms : {}), ...platforms };
  return {
    version,
    notes: `HII ${version}`,
    pub_date: publishedAt,
    platforms: merged
  };
}

/** Where an artifact is reachable once published to R2 behind the site. */
export function downloadUrl(platform) {
  return `${DOWNLOAD_ORIGIN}/download/${platform}`;
}

/**
 * Where the Tauri updater would fetch a platform's update payload.
 *
 * Unresolved, and deliberately not wired up: /download/* is session-gated, and
 * the updater plugin sends no cookie and no bearer token, so it cannot reach a
 * gated route. Serving updates during a private beta means either an
 * unauthenticated release path or no auto-update at all. Until that is decided,
 * the feed is generated but tauri.conf.json still points elsewhere -- so a
 * build cannot quietly start trusting a route nobody chose.
 */
export function updaterUrl(platform) {
  return `${DOWNLOAD_ORIGIN}/download/${platform}-updater`;
}
