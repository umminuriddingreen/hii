import type { Metadata } from 'next';
import { HiiLogo } from '@/components/brand/HiiLogo';

export const metadata: Metadata = {
  title: 'Thank you — HII'
};

export default function SupportThanksPage() {
  return (
    <main className="hii-next-shell min-h-screen">
      <header className="hii-next-nav" aria-label="HII">
        <a className="hii-next-brand" href="/">
          <HiiLogo title="HII" />
        </a>
      </header>

      <section className="hii-next-support" aria-label="Thank you">
        <p className="hii-next-kicker">support</p>
        <h1>Thank you.</h1>
        <p className="hii-next-lede">
          Your receipt is on its way from Stripe. HII keeps getting built — the work is
          public, and so is the direction it is going.
        </p>
        <div className="hii-next-actions">
          <a href="/">Back to HII</a>
          <a href="/architecture">See how it works</a>
        </div>
      </section>
    </main>
  );
}
