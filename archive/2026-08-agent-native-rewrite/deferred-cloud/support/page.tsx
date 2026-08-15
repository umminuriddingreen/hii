import type { Metadata } from 'next';
import { HiiLogo } from '@/components/brand/HiiLogo';
import { githubSponsorsUrl, stripeConfigured, supportAmounts } from '@/lib/server/support';
import { SupportForm } from './SupportForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Support HII',
  description:
    'HII is being built in the open. Help fund independent, user-owned infrastructure for human–agent computing.'
};

export default function SupportPage() {
  return (
    <main className="hii-next-shell min-h-screen">
      <header className="hii-next-nav" aria-label="HII">
        <a className="hii-next-brand" href="/">
          <HiiLogo title="HII" />
        </a>
        <nav aria-label="Primary">
          <a href="/workspace">Workspace</a>
          <a href="/knowledge">Knowledge</a>
          <a href="/console">Console</a>
          <a href="/support">Support</a>
        </nav>
      </header>

      <section className="hii-next-support" aria-label="Support HII">
        <p className="hii-next-kicker">support</p>
        <h1>HII is being built in the open.</h1>
        <p className="hii-next-lede">
          If you want to support independent, user-owned infrastructure for human–agent
          computing, you can help fund its development.
        </p>

        <div className="hii-next-support-panel">
          <SupportForm amounts={supportAmounts} stripeReady={stripeConfigured()} />
          <p className="hii-next-support-note">
            Or sponsor on{' '}
            <a href={githubSponsorsUrl} rel="noreferrer noopener" target="_blank">
              GitHub Sponsors
            </a>
            .
          </p>
        </div>

        <p className="hii-next-support-fine">
          This is a contribution toward development, not a purchase. It buys no license, no
          support agreement, no feature, and no influence over the roadmap, and it is not
          tax-deductible. HII has no paid tier today; if that ever changes, it will not be
          this page.
        </p>
      </section>
    </main>
  );
}
