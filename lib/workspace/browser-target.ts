export function normalizedBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 'https://developer.mozilla.org';
  if (/\s/.test(trimmed)) return null;
  const localBare = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  if (!localBare && /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : localBare
        ? `http://${trimmed}`
        : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function browserNavigationTarget(value: string) {
  const normalized = normalizedBrowserUrl(value);
  if (normalized) return normalized;
  const query = value.trim();
  if (!query || /^[a-z][a-z0-9+.-]*:/i.test(query)) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

export function browserTargetKind(value: string) {
  const normalized = normalizedBrowserUrl(value);
  if (!normalized) return 'invalid' as const;
  const hostname = new URL(normalized).hostname;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname) ? 'local-service' as const : 'website' as const;
}
