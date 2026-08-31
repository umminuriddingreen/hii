// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata, Viewport } from 'next';
import { SITE_ORIGIN, SITE_TAGLINE, SITE_TITLE } from '@/lib/site';
import './globals.css';
import './apps.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: SITE_TITLE,
    template: '%s · HII'
  },
  description: SITE_TAGLINE,
  applicationName: 'HII',
  manifest: '/manifest.webmanifest',
  alternates: { canonical: '/' },
  formatDetection: { telephone: false, address: false, email: false },
  icons: {
    icon: '/icon.svg',
    apple: '/hii-ecosystem-icon.svg'
  },
  appleWebApp: {
    capable: true,
    title: 'HII',
    statusBarStyle: 'default'
  },
  openGraph: {
    type: 'website',
    siteName: 'HII',
    url: '/',
    title: SITE_TITLE,
    description: SITE_TAGLINE,
    locale: 'en_US'
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_TAGLINE
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 }
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light',
  themeColor: '#ffffff'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="hii-skip-link" href="#hii-main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
