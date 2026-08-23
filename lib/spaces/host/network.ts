import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type SpacesHostMode = 'local' | 'lan';

export type SpacesHostBinding = {
  mode: SpacesHostMode;
  bindAddress: string;
  advertisedAddresses: string[];
  lanCidr?: string;
};

export class SpacesLanUnavailableError extends Error {
  readonly code = 'SPACES_LAN_UNAVAILABLE';

  constructor() {
    super(
      'No usable private IPv4 interface was found. Connect this Mac to the same Wi-Fi or Ethernet network as the visitor device and try again.'
    );
    this.name = 'SpacesLanUnavailableError';
  }
}

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

function ipv4Octets(raw: string): number[] | null {
  const normalized = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;
  const parts = normalized.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function ipv4Number(octets: number[]): number {
  return (
    (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>>
    0
  );
}

function isInIpv4Cidr(address: string, cidr: string): boolean {
  const separator = cidr.lastIndexOf('/');
  if (separator <= 0) return false;
  const networkOctets = ipv4Octets(cidr.slice(0, separator));
  const addressOctets = ipv4Octets(address);
  const prefix = Number(cidr.slice(separator + 1));
  if (!networkOctets || !addressOctets || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (ipv4Number(networkOctets) & mask) === (ipv4Number(addressOctets) & mask);
}

/** The socket peer, unlike Host or X-Forwarded-For, is not supplied by HTTP. */
export function isAllowedSpacesPeer(
  remoteAddress: string | undefined,
  binding: SpacesHostBinding
): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '::1') return true;
  const normalized = remoteAddress.toLowerCase().startsWith('::ffff:')
    ? remoteAddress.slice(7)
    : remoteAddress;
  const octets = ipv4Octets(normalized);
  if (!octets) return false;
  if (octets[0] === 127) return true;
  return binding.mode === 'lan' && typeof binding.lanCidr === 'string'
    ? isInIpv4Cidr(normalized, binding.lanCidr)
    : false;
}

function isPhysicalLanInterface(name: string): boolean {
  return /^en\d+$/.test(name) || /^eth\d+$/.test(name);
}

function isUsableIpv4(name: string, address: NetworkInterfaceInfo): boolean {
  return (
    isPhysicalLanInterface(name) &&
    address.family === 'IPv4' &&
    !address.internal &&
    address.address !== '0.0.0.0' &&
    !address.address.startsWith('169.254.') &&
    ipv4Octets(address.address) !== null &&
    typeof address.cidr === 'string' &&
    isInIpv4Cidr(address.address, address.cidr)
  );
}

/**
 * Resolve the listener separately from the URL shown to the operator.
 *
 * LAN mode binds one concrete physical interface rather than every interface.
 * Interface enumeration is injectable so selection can be proven without
 * changing the machine's network state.
 */
export function resolveSpacesHostBinding(
  mode: SpacesHostMode = 'local',
  interfaces: InterfaceMap = networkInterfaces()
): SpacesHostBinding {
  if (mode === 'local') {
    return {
      mode,
      bindAddress: '127.0.0.1',
      advertisedAddresses: ['127.0.0.1']
    };
  }

  const candidates = Object.entries(interfaces)
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((address) => isUsableIpv4(name, address))
        .map((address) => ({ name, address: address.address, cidr: address.cidr as string }))
    )
    .sort((left, right) => {
      const leftPriority = left.name === 'en0' ? 0 : left.name.startsWith('en') ? 1 : 2;
      const rightPriority = right.name === 'en0' ? 0 : right.name.startsWith('en') ? 1 : 2;
      return leftPriority - rightPriority || left.name.localeCompare(right.name) || left.address.localeCompare(right.address);
    });

  const selected = candidates[0];
  if (!selected) throw new SpacesLanUnavailableError();

  return {
    mode,
    bindAddress: selected.address,
    advertisedAddresses: [selected.address],
    lanCidr: selected.cidr
  };
}
