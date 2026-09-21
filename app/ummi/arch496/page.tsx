// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';
import Link from 'next/link';
import { ImpressionFeed } from './ImpressionFeed';
import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'Museum of the American Landscape — Ummi',
  description: 'An evolving ARCH495/496 case study connecting landscape, architecture, situated media, and agent-directed design work.',
  alternates: {
    canonical: '/ummi/arch496',
    types: {
      'application/rss+xml': '/ummi/arch496/feed.xml',
      'text/calendar': '/ummi/arch496/calendar.ics'
    }
  }
};

const evidence = [
  ['205', 'site photographs reviewed'],
  ['65', 'GPS + heading views mapped'],
  ['03', 'initial view corridors tested'],
  ['35k', 'square-foot museum program']
];

const agents = [
  ['Codex', 'Directs the objective, reviews evidence, coordinates tools, and verifies finished work.'],
  ['Local vision models', 'Classify site imagery, retrieve related research, and process high-volume visual context.'],
  ['QGIS', 'Builds the environmental evidence stack: terrain, canopy, soils, hydrology, access, and imagery.'],
  ['Rhino', 'Remains the authoritative design surface for massing, rooms, paths, views, and final geometry.'],
  ['HII', 'Binds intent, authority, agents, sources, artifacts, and receipts into one durable project thread.']
];

const submission = [
  ['01', 'Concept statement', 'Answer the assigned architectural-concept questions in the project’s own visual language.'],
  ['02', 'Thesis', 'One or two sentences—succinct, consequential, and placed early enough to guide the reading.'],
  ['03', 'Three concept models', '1/32\" = 1\' assemblies of parts, photographed and color-corrected on white. Not foam-block massing.'],
  ['04', 'Site collages', 'Top-view aerial placement, a repeated field-condition study, and one atmospheric perspective encounter.'],
  ['05', 'Program diagram', 'Interior and exterior relationships, areas, volumes, and comparison to requirements—not a generic bubble diagram.'],
  ['06', 'Site research drawing', 'A synthetic layering of context, ecology, circulation, public space, topography, and easements.'],
  ['07', 'Graphic sources', 'Field-condition and concept inspiration images with concise written readings.']
];

export default function Arch496CaseStudy() {
  return (
    <main id="hii-main" className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="HII home">hii</Link>
        <div className={styles.identity}>
          <span>ummi</span>
          <span>architecture · intelligence · landscape</span>
        </div>
        <nav aria-label="Case study sections">
          <a href="#experience">Experience</a>
          <a href="#process">Process</a>
          <a href="#submission">Submission</a>
          <a href="#evidence">Evidence</a>
        </nav>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>ARCH 495/496 · Natirar, New Jersey · active study</p>
          <h1>Museum of the<br /><em>American Landscape</em></h1>
          <p className={styles.deck}>A museum distributed across a living site—where architecture, landscape, and context-aware media guide attention without replacing direct experience.</p>
          <div className={styles.statusRow}>
            <span><i className={styles.liveDot} /> HII project thread active</span>
            <span>Rhino + QGIS + situated intelligence</span>
          </div>
        </div>
        <figure className={styles.heroImage}>
          <img src="/projects/arch496/site-program-perspective.png" alt="Rhino study connecting museum program to contextual landscape zones" />
          <figcaption>
            <span>Program + view field</span>
            <span>Registered hypothesis · not final placement</span>
          </figcaption>
        </figure>
      </section>

      <section className={styles.manifesto}>
        <p className={styles.sectionIndex}>01 / Thesis</p>
        <blockquote>“The landscape is not outside the museum. It is the medium through which the museum is understood.”</blockquote>
        <div className={styles.manifestoGrid}>
          <p>The project begins with a human sequence: access, terrain transition, compression, threshold, rooms, framed views, and return. The building is one concentrated node in a wider field of encounters.</p>
          <p>A location-aware feed offers fragments—images, texts, sound, history, and environmental observations—only when they can turn attention back toward something physically present.</p>
        </div>
      </section>

      <section id="experience" className={styles.experience}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionIndex}>02 / Experience</p>
            <h2>Modern impressionism,<br />situated in the site.</h2>
          </div>
          <p>Not turn-by-turn navigation. A quiet sequence of prompts that changes with location, direction, pace, weather, and what a visitor has already encountered.</p>
        </div>
        <ImpressionFeed />
      </section>

      <section className={styles.spatialSequence}>
        <p className={styles.sectionIndex}>03 / Spatial sequence</p>
        <div className={styles.sequenceLine}>
          {['Arrival', 'Terrain transition', 'Threshold', 'Museum rooms', 'Landscape return'].map((label, index) => (
            <div key={label}><span>0{index + 1}</span><strong>{label}</strong></div>
          ))}
        </div>
        <figure className={styles.sequenceImage}>
          <img src="/projects/arch496/lower-ridge.png" alt="Extracted lower ridge site path used to study movement through the landscape" />
          <figcaption>The path is both circulation and exhibition infrastructure.</figcaption>
        </figure>
      </section>

      <section id="process" className={styles.process}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionIndex}>04 / Intelligence at work</p>
            <h2>More context.<br />Less interface.</h2>
          </div>
          <p>Codex drives the work. Local models increase processing capacity. HII keeps the system convergent, bounded, and inspectable so stronger intelligence becomes higher design velocity.</p>
        </div>
        <div className={styles.agentStack}>
          {agents.map(([name, role], index) => (
            <article key={name}>
              <span>0{index + 1}</span>
              <h3>{name}</h3>
              <p>{role}</p>
            </article>
          ))}
        </div>
        <div className={styles.loop}>
          <span>intent</span><i>→</i><span>context</span><i>→</i><span>agent work</span><i>→</i><span>artifact</span><i>→</i><span>proof</span>
        </div>
      </section>

      <section id="submission" className={styles.submission}>
        <div className={styles.submissionIntro}>
          <div>
            <p className={styles.sectionIndex}>05 / Studio brief</p>
            <p className={styles.deadline}>Due 09.22.26 · 12:00 PM</p>
          </div>
          <h2>One project.<br />One designed PDF.</h2>
          <p>The submission is not seven unrelated assignments. Each artifact should test the same thesis through a different medium: words, assembled matter, aerial field, perspective atmosphere, program, and site evidence.</p>
        </div>
        <div className={styles.submissionGrid}>
          {submission.map(([number, title, description]) => (
            <article key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
        <aside className={styles.courseCorrection}>
          <strong>Current model status</strong>
          <p>The colored Rhino volumes are a program and proximity study. They should inform—but must not be presented as—the final building mass.</p>
        </aside>
      </section>

      <section id="evidence" className={styles.evidence}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionIndex}>06 / Evidence</p>
            <h2>Design claims remain<br />attached to their sources.</h2>
          </div>
          <p>Recorded views guide the current hypothesis, but they do not become truth by presentation. Registration uncertainty, inferred affinities, and incomplete environmental validation remain visible.</p>
        </div>
        <div className={styles.metrics}>
          {evidence.map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
        </div>
        <div className={styles.evidenceGrid}>
          <figure>
            <img src="/projects/arch496/view-mass-plan.png" alt="View corridor mass study with provisional registration" />
            <figcaption><strong>View / void / mass</strong><span>Provisional study · 54 ft RMS registration error</span></figcaption>
          </figure>
          <figure>
            <img src="/projects/arch496/geolocated-views.png" alt="Geolocated views and curatorial affinities mapped across the site" />
            <figcaption><strong>Position + direction</strong><span>Source metadata separated from design inference</span></figcaption>
          </figure>
        </div>
      </section>

      <footer className={styles.footer}>
        <div>
          <span className={styles.brand}>hii</span>
          <p>Human Information Interface</p>
        </div>
        <p>Project by Ummi Nuriddin Green<br />NJIT · Hillier College of Architecture and Design</p>
        <p>Living case study<br />Last assembled September 20, 2026</p>
        <div className={styles.subscribe}>
          <a href="/ummi/arch496/calendar.ics">Subscribe to calendar</a>
          <a href="/ummi/arch496/feed.xml">Follow project RSS</a>
        </div>
      </footer>
    </main>
  );
}
