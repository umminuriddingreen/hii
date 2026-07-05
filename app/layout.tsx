import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AliveBars } from './AliveBars';

export const metadata: Metadata = {
  title: 'hii — conversational computer work',
  description: 'Turn tasks, files, agents, credits, proof, and payments into one conversation transcript.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-black">
        <AliveBars />
        <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
          <div>
            <Link href="/" className="font-mono text-lg font-bold">
              hii
            </Link>
            <span className="ml-3 text-sm text-neutral-500">people, information, tools</span>
          </div>
          <nav className="flex gap-4 text-sm">
            <Link href="/feed" className="text-neutral-600 hover:text-black">Feed</Link>
            <Link href="/boards" className="text-neutral-600 hover:text-black">Boards</Link>
            <Link href="/terminal" className="text-neutral-600 hover:text-black">Terminal</Link>
            <Link href="/credits" className="text-neutral-600 hover:text-black">Credits</Link>
            <Link href="/termite" className="text-neutral-600 hover:text-black">Termite</Link>
            <Link href="/upload" className="text-neutral-600 hover:text-black">New exchange</Link>
            <Link href="/dashboard" className="text-neutral-600 hover:text-black">Dashboard</Link>
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
