import { describe, expect, it } from 'vitest';
import {
  HII_PUBLIC_SPACES_ORIGIN,
  buildLocalSpaceUrl,
  buildPublishedSpaceUrl,
  spaceAccessPath,
  trustedSpaceOrigin
} from '../../lib/spaces/access-link';

describe('Space access links', () => {
  it('builds a local URL from a trusted host origin', () => {
    expect(buildLocalSpaceUrl('14th-street', 'http://192.168.1.12:4312')).toBe(
      'http://192.168.1.12:4312/s/14th-street'
    );
    expect(buildLocalSpaceUrl('14th-street', 'http://127.0.0.1:4312/')).toBe(
      'http://127.0.0.1:4312/s/14th-street'
    );
  });

  it('projects the same stable Space id through local and published hosts', () => {
    const local = buildLocalSpaceUrl('14th-street', 'http://10.0.0.4:4312');
    const published = buildPublishedSpaceUrl('14th-street');
    expect(new URL(local).pathname).toBe('/s/14th-street');
    expect(new URL(published).pathname).toBe('/s/14th-street');
    expect(published).toBe(`${HII_PUBLIC_SPACES_ORIGIN}/s/14th-street`);
  });

  it('supports a provider-independent published origin without changing identity', () => {
    expect(buildPublishedSpaceUrl('s1', 'https://spaces.example.test')).toBe(
      'https://spaces.example.test/s/s1'
    );
  });

  it('refuses credentials, paths, queries, fragments, and insecure public origins', () => {
    for (const origin of [
      'http://user:pass@10.0.0.4:4312',
      'http://10.0.0.4:4312/untrusted',
      'http://10.0.0.4:4312?host=other',
      'http://10.0.0.4:4312/#other'
    ]) {
      expect(() => trustedSpaceOrigin(origin), origin).toThrow(TypeError);
    }
    expect(() => buildPublishedSpaceUrl('s1', 'http://public.example.test')).toThrow(TypeError);
  });

  it('refuses a noncanonical id instead of encoding infrastructure into it', () => {
    for (const id of ['../escape', 'https://host.test/s/id', 'Space ID', '']) {
      expect(() => spaceAccessPath(id), id).toThrow(TypeError);
    }
  });
});
