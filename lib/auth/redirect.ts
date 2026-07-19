const FALLBACK_PATH = '/dashboard';
const INTERNAL_ORIGIN = 'https://hii.local';

/** Keep post-auth redirects inside HII and reject protocol-relative or malformed targets. */
export function safeNextPath(value: string | null | undefined, fallback = FALLBACK_PATH) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }

  try {
    const target = new URL(value, INTERNAL_ORIGIN);
    if (target.origin !== INTERNAL_ORIGIN) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}
