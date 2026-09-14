// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';
import { DesktopRelease } from '@/components/public/DesktopRelease';
import { CommunityManifest } from './community-manifest';
import styles from './store.module.css';

export const metadata: Metadata = {
  title: 'App Store',
  description: 'Find official HII software and inspect community applications before registering them locally.',
  alternates: { canonical: '/store' }
};

export default function StorePage() {
  return (
    <main className={styles.store} id="hii-main">
      <header className={styles.topbar}>
        <a className={styles.brand} href="/" aria-label="HII home"><span className={styles.mark}>hii</span><span>Human Information Interface</span></a>
        <nav aria-label="Store navigation"><a href="#official">Official software</a><a href="#community">Community</a><a href="/docs">Documentation</a></nav>
        <a className={styles.topAction} href="/">Open HII <span aria-hidden="true">↗</span></a>
      </header>

      <section className={styles.hero} aria-labelledby="store-title">
        <div className={styles.heroText}>
          <p className={styles.eyebrow}><span className={styles.liveDot} /> HII / Software</p>
          <h1 id="store-title">Bring more into your space.</h1>
          <p>Start with HII, enter its official workspaces, and bring reviewed applications into your own local runtime. Every install path should say what it actually changes.</p>
          <a className={styles.heroLink} href="#official">Explore software <span aria-hidden="true">↓</span></a>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <div className={styles.orbitOne} /><div className={styles.orbitTwo} />
          <div className={styles.orbitThree} /><div className={styles.axisH} /><div className={styles.axisV} />
          <div className={styles.heroCore}>hii</div>
          <span className={styles.artLabelOne}>YOUR SPACE</span><span className={styles.artLabelTwo}>+ CAPABILITY</span>
        </div>
      </section>

      <section className={styles.catalog} id="official" aria-labelledby="official-title">
        <div className={styles.sectionLead}><div><p className={styles.kicker}>Made by HII</p><h2 id="official-title">Official software</h2></div><p>Direct from HII. Release availability is checked live.</p></div>
        <article className={styles.feature}>
          <div className={styles.featureIcon} aria-hidden="true"><span>hii</span></div>
          <div className={styles.featureBody}><div className={styles.featureMeta}><span>Desktop application</span><span className={styles.officialBadge}>Official</span></div><h3>HII for Mac and Windows</h3><p>Your local-first canvas, agent runtime, files, and proof on your own computer.</p><div className={styles.platforms}><span>macOS · Apple Silicon</span><span>Windows · x64</span></div></div>
          <div className={styles.featureActions}><a href="/download">View release details <span aria-hidden="true">↗</span></a><small>Private beta · account required</small></div>
        </article>
        <div className={styles.releaseGrid}>
          <div><h4>Mac release</h4><DesktopRelease platform="macos" label="Download for Mac" /></div>
          <div><h4>Windows release</h4><DesktopRelease platform="windows" label="Download for Windows" /></div>
        </div>
        <article className={styles.workspaceRow}>
          <span className={styles.workspaceSymbol} aria-hidden="true">◉</span>
          <div><div className={styles.featureMeta}><span>Web workspace</span><span className={styles.officialBadge}>Official</span></div><h3>Site Analysis</h3><p>Locate a site, examine mapped context, and prepare source-linked design data.</p></div>
          <a href="/site-analysis">Open workspace <span aria-hidden="true">↗</span></a>
        </article>
      </section>

      <section className={styles.community} id="community" aria-labelledby="community-title">
        <div className={styles.sectionLead}><div><p className={styles.kicker}>Bring your own</p><h2 id="community-title">Community applications</h2></div><p>HII is preparing a reviewed catalog. There are no verified community listings available for one-click install yet.</p></div>
        <div className={styles.communityGrid}>
          <div className={styles.communityIntro}>
            <span className={styles.communityGlyph} aria-hidden="true">+</span>
            <h3>Inspect before you register.</h3>
            <p>Application manifests declare the developer, surfaces, and requested capabilities. The local HII CLI can register a manifest you have reviewed; registering it does not download or run the application code.</p>
            <ol><li>Get the manifest from a developer you trust.</li><li>Inspect its identity and capability requests here.</li><li>Register it in your local HII runtime.</li></ol>
          </div>
          <CommunityManifest />
        </div>
      </section>
      <footer className={styles.footer}><span>HII / User-owned capability</span><div><a href="/privacy">Privacy</a><a href="/docs">Docs</a><a href="/download">Downloads</a></div></footer>
    </main>
  );
}
