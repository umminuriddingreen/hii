import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'hii — exchange a file for value',
  description: 'Turn a digital file into an exchange link: price, terms, payment, delivery, and access tracking built in.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-black">
        <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
          <div>
            <Link href="/" className="font-mono text-lg font-bold">
              hii
            </Link>
            <span className="ml-3 text-sm text-neutral-500">exchange a file for value</span>
          </div>
          <nav className="flex gap-4 text-sm">
            <Link href="/upload" className="text-neutral-600 hover:text-black">New exchange</Link>
            <Link href="/dashboard" className="text-neutral-600 hover:text-black">Dashboard</Link>
          </nav>
        </header>
        <main className="mx-auto max-w-2xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
