// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'HII keeps context local by default. Your computer decides what leaves.',
  alternates: { canonical: '/privacy' }
};

export default function PrivacyPage() {
  return (
    <main className="public-home" id="hii-main">
      <p className="public-name">HII / Privacy</p>
      <h1>Your computer decides what leaves.</h1>
      <p>HII keeps context local by default. Hosted transmission, publishing, messaging, spending, deletion, and security changes remain visible and explicitly authorized.</p>
      <nav><a href="/">Home</a><a href="/docs">Documentation</a></nav>
    </main>
  );
}
