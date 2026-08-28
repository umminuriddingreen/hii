// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata, Viewport } from 'next';
import './globals.css';
import './apps.css';

export const metadata: Metadata = {
  title: 'HII',
  description: 'An infinite 2D canvas.',
  manifest: '/manifest.webmanifest'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
