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
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1d1d1f' }
  ]
};

const themeBootstrap = `(() => {
  try {
    const preference = localStorage.getItem('hii.theme.v1') || 'system';
    const resolved = preference === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch (_) {}
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body>
        <a className="hii-skip-link" href="#hii-main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
