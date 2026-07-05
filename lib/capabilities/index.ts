import capabilitiesJson from './registry.json';
import type { CapabilityDefinition } from './types';

export const capabilities = capabilitiesJson as CapabilityDefinition[];

export function listCapabilities() {
  return capabilities;
}

export function getCapability(id: string) {
  return capabilities.find((capability) => capability.id === id) ?? null;
}

export function requireCapability(id: string) {
  const capability = getCapability(id);
  if (!capability) throw new Error(`Unknown capability: ${id}`);
  return capability;
}
