import Link from 'next/link';
import { AliveBars } from '../../AliveBars';
import { HiiLogo } from '../../../components/brand/HiiLogo';

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="hii-knowledge-root">
      <AliveBars />
      <header className="hii-knowledge-topbar">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="hii-knowledge-mark" aria-label="HII home">
            <HiiLogo />
          </Link>
          <span className="hii-knowledge-slash">/</span>
          <span className="truncate font-mono text-xs font-semibold uppercase tracking-[0.16em]">knowledge</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-neutral-500">
          <span className="hii-knowledge-local"><i /> local</span>
          <Link href="/boards" className="hii-knowledge-toplink">boards</Link>
          <Link href="/console" className="hii-knowledge-toplink">console</Link>
        </div>
      </header>
      {children}
    </div>
  );
}
