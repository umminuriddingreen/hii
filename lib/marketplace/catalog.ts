// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { NodeSeed } from '@/lib/workspace/ingest';

export type HiiPackageKind = 'app' | 'experience' | 'skill' | 'runtime';
export type HiiBilling =
  | { model: 'free'; label: 'Free' }
  | { model: 'one-time'; amountUsd: number; label: string }
  | { model: 'subscription'; amountUsd: number; interval: 'month' | 'year'; trialDays?: number; label: string };

export type HiiMarketplacePackage = {
  id: string;
  name: string;
  version: string;
  kind: HiiPackageKind;
  developer: { name: string; handle: string; verified: boolean; homepage: string };
  summary: string;
  source: { model: 'developer-hosted'; manifestUrl: string; codeOwnership: 'developer' };
  license: { spdx: string; name: string; url: string };
  billing: HiiBilling;
  capabilities: Array<{ id: string; authority: 'observe' | 'propose' | 'execute'; reason: string }>;
  surface: string;
};

export const WAYMARK_PACKAGE: HiiMarketplacePackage = {
  id: 'community.waymark.location-studio',
  name: 'Waymark',
  version: '0.2.0-beta',
  kind: 'app',
  developer: {
    name: 'Waymark Labs',
    handle: '@waymark',
    verified: false,
    homepage: 'https://example.invalid/waymark'
  },
  summary: 'Pick, save, and preview a location for governed device workflows.',
  source: {
    model: 'developer-hosted',
    manifestUrl: 'https://example.invalid/waymark/hii-package.json',
    codeOwnership: 'developer'
  },
  license: {
    spdx: 'LicenseRef-Waymark-Community',
    name: 'Community use license',
    url: 'https://example.invalid/waymark/license'
  },
  billing: { model: 'subscription', amountUsd: 4, interval: 'month', trialDays: 7, label: '$4 / month' },
  capabilities: [
    { id: 'hii.location.preview', authority: 'observe', reason: 'Read and preview coordinates in this app.' },
    { id: 'hii.device.location.propose', authority: 'propose', reason: 'Propose a location change to an enrolled device.' }
  ],
  surface: 'waymark-location'
};

export const MARKETPLACE_PACKAGES = [WAYMARK_PACKAGE];

export function packagePlacementSeed(pkg: HiiMarketplacePackage, destination: string): NodeSeed {
  const now = new Date().toISOString();
  return {
    type: 'app',
    w: 1080,
    h: 720,
    object: {
      kind: 'interface',
      owner: 'human',
      status: 'ready',
      source: 'HII marketplace concept preview',
      capabilityId: 'hii.marketplace.preview',
      audit: [{ ts: now, actor: 'human', action: `placed ${pkg.name} ${pkg.version} concept preview in ${destination}` }]
    },
    payload: {
      surface: pkg.surface,
      title: pkg.name,
      packageId: pkg.id,
      packageVersion: pkg.version,
      destination,
      developer: pkg.developer.name,
      manifestUrl: pkg.source.manifestUrl,
      license: pkg.license.name,
      billing: pkg.billing,
      capabilities: pkg.capabilities,
      windowState: 'normal',
      simulated: true
    }
  };
}
