'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AliveBars } from '../AliveBars';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === '/landing') {
    return <>{children}</>;
  }

  return (
    <div className="hii-app-shell">
      <AliveBars />
      <header className="hii-topbar sticky top-0 z-40 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-baseline gap-3">
            <Link href="/" className="font-mono text-lg font-black uppercase text-[var(--hii-electric-blue)] underline underline-offset-2">
              hii
            </Link>
            <span className="font-mono text-xs uppercase text-neutral-600">control plane</span>
          </div>
          <nav className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
            <Link href="/" className="hii-nav-link">Desk</Link>
            <Link href="/landing" className="hii-nav-link">Playbook</Link>
            <Link href="/feed" className="hii-nav-link">Feed</Link>
            <Link href="/knowledge" className="hii-nav-link">Knowledge</Link>
            <Link href="/boards" className="hii-nav-link">Boards</Link>
            <Link href="/console" className="hii-nav-link">Console</Link>
            <Link href="/credits" className="hii-nav-link">Credits</Link>
            <Link href="/termite" className="hii-nav-link">Termite</Link>
            <Link href="/upload" className="hii-nav-link">Exchange</Link>
            <Link href="/dashboard" className="hii-nav-link">Dashboard</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-10">{children}</main>
    </div>
  );
}
