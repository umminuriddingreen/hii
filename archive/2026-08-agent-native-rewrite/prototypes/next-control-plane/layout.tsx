// SPDX-License-Identifier: LicenseRef-BSL-1.1
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'hii - verified agent work',
  description: 'Local-first control plane for capabilities, approvals, jobs, proof, and receipts.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
