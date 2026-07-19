import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../../lib/auth/redirect';

const login = readFileSync('src/routes/(app)/login/+page.svelte', 'utf8');
const callback = readFileSync('src/routes/auth/[...path]/+server.ts', 'utf8');

describe('HII account login', () => {
  it('offers Google, Apple, and passwordless email through the shared callback', () => {
    expect(login).toContain("type SocialProvider = 'google' | 'apple'");
    expect(login).toContain("signInWithOAuth");
    expect(login).toContain("signInWith('google')");
    expect(login).toContain("signInWith('apple')");
    expect(login).toContain('signInWithOtp');
    expect(login).toContain('/auth/callback?next=');
    expect(login).toContain('Google · setup pending');
    expect(login).toContain('Apple · setup pending');
  });

  it('only accepts internal post-auth destinations', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/knowledge?view=graph#active')).toBe('/knowledge?view=graph#active');
    expect(safeNextPath('https://example.com')).toBe('/dashboard');
    expect(safeNextPath('//example.com')).toBe('/dashboard');
    expect(safeNextPath('/\\example.com')).toBe('/dashboard');
    expect(callback).toContain('exchangeCodeForSession(code)');
    expect(callback).toContain("redirect(303, next)");
  });
});
