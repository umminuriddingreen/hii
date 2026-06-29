import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'hii — exchange a file for value',
  description: 'Sell one track. Get one link.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100">
        <header className="border-b border-neutral-800 px-6 py-4">
          <Link href="/" className="font-mono text-lg font-bold">
            hii
          </Link>
          <span className="ml-3 text-sm text-neutral-500">exchange a file for value</span>
        </header>
        <main className="mx-auto max-w-2xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
