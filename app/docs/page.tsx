// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'How HII connects information, actions, results, and proof on your own machine.',
  alternates: { canonical: '/docs' }
};

export default function DocsPage() {
  return (
    <main className="public-home" id="hii-main">
      <p className="public-name">HII / Documentation</p>
      <h1>Human information, agent capability.</h1>
      <p>Press Fn + Shift anywhere on the Mac, reference what matters, and tell HII what should happen. The persistent canvas keeps information, actions, results, and proof together.</p>
      <nav><a href="/">Home</a><a href="/privacy">Privacy</a></nav>
    </main>
  );
}
