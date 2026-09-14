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
        <label>Preview in<select value={destination} onChange={(event) => setDestination(event.target.value)}><option>this canvas</option><option>this workspace</option><option>new canvas</option></select></label>
      </header>
      <div className="hii-marketplace-body">
        <nav aria-label="Marketplace packages">
          {MARKETPLACE_PACKAGES.map((entry) => <button key={entry.id} aria-pressed={entry.id === selected} onClick={() => setSelected(entry.id)}><span>↗</span><b>{entry.name}</b><small>{entry.kind} · concept preview</small></button>)}
          <p>This is a concept preview. No publisher, package, license, or installation is verified here. <a href="/store">Open the HII App Store ↗</a></p>
        </nav>
        <article>
          <div className="hii-marketplace-hero"><span>LOCATION / 01</span><h2>{pkg.name}</h2><p>{pkg.summary}</p></div>
          <dl>
            <div><dt>Developer claim</dt><dd>{pkg.developer.name} <small>{pkg.developer.handle}</small></dd></div>
            <div><dt>Source</dt><dd>No package available <small>concept only</small></dd></div>
            <div><dt>License</dt><dd>Unverified <small>no offer</small></dd></div>
            <div><dt>Access</dt><dd>Preview only <small>no billing</small></dd></div>
          </dl>
          <section className="hii-marketplace-permissions"><strong>Requested capabilities</strong>{pkg.capabilities.map((capability) => <p key={capability.id}><span>{capability.authority}</span><b>{capability.id}</b><small>{capability.reason}</small></p>)}</section>
          <footer><p>Placing this preview creates a canvas object only. It does not download software, register a package, or take payment.</p><button onClick={() => onInstall(pkg, destination)}>Place preview in {destination}<span>Concept</span></button></footer>
        </article>
      </div>
    </section>
  );
}
