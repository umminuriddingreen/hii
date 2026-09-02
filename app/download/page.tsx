// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';
import { DesktopRelease } from '@/components/public/DesktopRelease';

export const metadata: Metadata = {
  title: 'Download',
  description: 'Install the native HII canvas for Mac and Windows.',
  alternates: { canonical: '/download' }
};

export default function DownloadPage() {
  return (
    <main className="public-home" id="hii-main">
      <p className="public-name">HII / Download</p>
      <h1>HII for your computer.</h1>
      <p>
        HII is a Tauri desktop app for Mac and Windows. It is the same canvas the browser
        shows, running locally with terminals, agents and the <code>hii</code> command line
        alongside it.
      </p>
      <p>
        The desktop app opens on the local Runtime document in <code>~/.hii</code>, which is
        yours alone and never leaves the machine. Signing in and choosing an account workspace
        is what puts a document in the cloud, and only that document syncs — every canvas that
        stays local, stays local.
      </p>
      <p>
        Downloads are for signed-in accounts during the private beta. Sign in on the home page
        first; the links below will return an authentication error otherwise.
      </p>
      <section id="mac">
        <h2>Mac</h2>
        <p>Apple Silicon, macOS 13 or newer. Open the disk image and drag HII to Applications.</p>
        <DesktopRelease platform="macos" label="Download for Mac" />
        <p>
          HII keeps itself current after that. It checks for a new version on launch, installs
          only when you say so, and verifies every update against HII&rsquo;s signing key before
          applying it.
        </p>
      </section>
      <section id="windows">
        <h2>Windows</h2>
        <p>
          64-bit Windows 10 or newer. Run the installer; it installs per-user under{' '}
          <code>%LOCALAPPDATA%\Programs\HII</code> and needs no administrator.
        </p>
        <DesktopRelease platform="windows" label="Download for Windows" />
      </section>
      <section id="signing">
        <h2>These builds are not code-signed yet</h2>
        <p>
          Apple Developer ID notarization and Windows Authenticode are not in place. macOS will
          say the app is from an unidentified developer, and SmartScreen will warn on the
          Windows installer. Check the SHA-256 shown above against the downloaded file before
          you run it, and expect one extra confirmation on first launch.
        </p>
      </section>
      <nav><a href="/">Home</a><a href="/docs">Documentation</a></nav>
    </main>
  );
}
