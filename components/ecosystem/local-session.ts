import type { EcosystemSession } from '@/lib/ecosystem/contracts';

export type EcosystemEnvironment = {
  hostname: string;
  isTauri: boolean;
};

export const LOCAL_OWNER_SESSION: EcosystemSession = {
  state: 'authenticated',
  owner: { id: 'owner:local', displayName: 'Local owner mode', deviceName: 'This HII device' }
};

export function ecosystemSessionForEnvironment(environment: EcosystemEnvironment): EcosystemSession {
  const hostname = environment.hostname.toLocaleLowerCase();
  const loopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost');
  return environment.isTauri || loopback ? LOCAL_OWNER_SESSION : { state: 'signed-out' };
}
