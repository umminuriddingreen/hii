import type { Metadata } from 'next';
import { BrowserSyncSetup } from './BrowserSyncSetup';

export const metadata: Metadata = {
  title: 'Browser Sync | HII',
  description: 'Pair Helium and Chrome through the local HII browser sync relay.'
};

const extensionPath = '/Users/ummi/hii/extensions/helium-sync';

export default function BrowserSyncPage() {
  return (
    <main className="hii-sync-page">
      <header className="hii-sync-header">
        <a href="/">HII</a>
        <span>Browser Sync</span>
      </header>
      <section className="hii-sync-hero">
        <p className="hii-sync-eyebrow">Next.js App Router / React</p>
        <h1>Move web context between Helium and Chrome without a cloud account.</h1>
        <p>Bookmarks, history, optional tab metadata, and an encrypted extension vault flow through a local authenticated HII endpoint.</p>
      </section>
      <BrowserSyncSetup />
      <section className="hii-sync-card">
        <p className="hii-sync-eyebrow">Install</p>
        <h2>Load the extension in both browsers</h2>
        <ol>
          <li>Open <code>chrome://extensions</code> in Helium and Chrome.</li>
          <li>Enable Developer mode and choose <strong>Load unpacked</strong>.</li>
          <li>Select <code>{extensionPath}</code>.</li>
          <li>Open extension Options and paste the same generated key into both browsers.</li>
          <li>Use <strong>Sync now</strong> from each browser toolbar.</li>
        </ol>
      </section>
      <section className="hii-sync-card">
        <p className="hii-sync-eyebrow">Security boundary</p>
        <h2>Passwords are extension-owned</h2>
        <p>Chromium does not expose browser-native saved passwords to extensions. Chrome CSV imports are encrypted client-side before the local relay receives them. Keep an audited password manager as your recovery source.</p>
      </section>
    </main>
  );
}
