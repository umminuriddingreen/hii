import { describe, expect, it } from 'vitest';
import { browserTargetKind, normalizedBrowserUrl } from '@/lib/workspace/browser-target';

describe('HII interactive browser targets', () => {
  it('defaults bare localhost services to http', () => {
    expect(normalizedBrowserUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizedBrowserUrl('127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
  });

  it('defaults public hosts to https and rejects non-web protocols', () => {
    expect(normalizedBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizedBrowserUrl('file:///tmp/private')).toBeNull();
  });

  it('distinguishes local services from public websites', () => {
    expect(browserTargetKind('http://127.0.0.1:3000')).toBe('local-service');
    expect(browserTargetKind('http://[::1]:3000')).toBe('local-service');
    expect(browserTargetKind('https://humaninformationinterface.com')).toBe('website');
    expect(browserTargetKind('not a url')).toBe('invalid');
  });
});
