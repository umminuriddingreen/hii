'use client';

import { useState } from 'react';
import { MARKETPLACE_PACKAGES, type HiiMarketplacePackage } from '@/lib/marketplace/catalog';

export function HiiMarketplace({ onInstall }: { onInstall: (pkg: HiiMarketplacePackage, destination: string) => void }) {
  const [destination, setDestination] = useState('this canvas');
  const [selected, setSelected] = useState(MARKETPLACE_PACKAGES[0].id);
  const pkg = MARKETPLACE_PACKAGES.find((entry) => entry.id === selected) || MARKETPLACE_PACKAGES[0];
  return (
    <section className="hii-marketplace">
      <header>
        <div><i aria-hidden="true">hii</i><span><strong>Community market</strong><small>Apps · experiences · skills · runtimes</small></span></div>
        <label>Install to<select value={destination} onChange={(event) => setDestination(event.target.value)}><option>this canvas</option><option>this workspace</option><option>new canvas</option></select></label>
      </header>
      <div className="hii-marketplace-body">
        <nav aria-label="Marketplace packages">
          {MARKETPLACE_PACKAGES.map((entry) => <button key={entry.id} aria-pressed={entry.id === selected} onClick={() => setSelected(entry.id)}><span>↗</span><b>{entry.name}</b><small>{entry.kind} · {entry.billing.label}</small></button>)}
          <p>Developers host their own code. HII verifies the manifest, scopes authority, handles licensing, and leaves an install receipt.</p>
        </nav>
        <article>
          <div className="hii-marketplace-hero"><span>LOCATION / 01</span><h2>{pkg.name}</h2><p>{pkg.summary}</p></div>
          <dl>
            <div><dt>Developer</dt><dd>{pkg.developer.name} <small>{pkg.developer.handle}</small></dd></div>
            <div><dt>Source</dt><dd>Developer-hosted <small>code stays theirs</small></dd></div>
            <div><dt>License</dt><dd>{pkg.license.name} <small>{pkg.license.spdx}</small></dd></div>
            <div><dt>Access</dt><dd>{pkg.billing.label} <small>{pkg.billing.model === 'subscription' && pkg.billing.trialDays ? `${pkg.billing.trialDays}-day trial` : pkg.billing.model}</small></dd></div>
          </dl>
          <section className="hii-marketplace-permissions"><strong>Requested capabilities</strong>{pkg.capabilities.map((capability) => <p key={capability.id}><span>{capability.authority}</span><b>{capability.id}</b><small>{capability.reason}</small></p>)}</section>
          <footer><p>No payment is taken in this preview. Subscription activation requires explicit checkout approval.</p><button onClick={() => onInstall(pkg, destination)}>Install to {destination}<span>{pkg.billing.label}</span></button></footer>
        </article>
      </div>
    </section>
  );
}
