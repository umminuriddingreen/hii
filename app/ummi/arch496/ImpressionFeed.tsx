'use client';

import { useState } from 'react';
import styles from './page.module.css';

const moments = [
  {
    id: 'arrival',
    index: '01',
    place: 'Arrival / service approach',
    distance: 'You are here',
    prompt: 'The road is still doing the work of arrival. Look for the first moment the estate gives way to the museum.',
    media: 'Field note · IMG_0460',
    tone: 'ochre'
  },
  {
    id: 'threshold',
    index: '02',
    place: 'Tree row / threshold',
    distance: '4 min walk',
    prompt: 'Canopy compresses the path. The building should be sensed here before it is fully seen.',
    media: 'View trace · canopy + heading',
    tone: 'green'
  },
  {
    id: 'meadow',
    index: '03',
    place: 'River / great meadow',
    distance: '9 min walk',
    prompt: 'A long view turns the collection outward. Pause before the gallery frames what the landscape already holds.',
    media: 'Kensett + Schofield affinity',
    tone: 'blue'
  },
  {
    id: 'return',
    index: '04',
    place: 'Landscape return',
    distance: 'After the galleries',
    prompt: 'The interface recedes. What changed is not the site, but what you are now prepared to notice.',
    media: 'Quiet zone · no screen required',
    tone: 'black'
  }
];

export function ImpressionFeed() {
  const [active, setActive] = useState(0);
  const moment = moments[active];

  return (
    <div className={styles.feedShell}>
      <div className={styles.feedMap} aria-label="Conceptual site sequence">
        <img src="/projects/arch496/geolocated-views.png" alt="Geolocated view directions across the Natirar project site" />
        <div className={styles.feedMapVeil} />
        <p className={styles.locationSignal}><span /> Location-aware · private by default</p>
        <div className={styles.routeLine} aria-hidden="true" />
        {moments.map((item, index) => (
          <button
            className={`${styles.mapPin} ${styles[`pin${index + 1}`]} ${active === index ? styles.mapPinActive : ''}`}
            key={item.id}
            onClick={() => setActive(index)}
            aria-label={`Open ${item.place}`}
            aria-pressed={active === index}
          >
            {item.index}
          </button>
        ))}
      </div>

      <article className={styles.impressionCard} data-tone={moment.tone} aria-live="polite">
        <div className={styles.impressionMeta}>
          <span>{moment.index} / 04</span>
          <span>{moment.distance}</span>
        </div>
        <p className={styles.eyebrow}>A situated impression</p>
        <h3>{moment.place}</h3>
        <p className={styles.impressionPrompt}>{moment.prompt}</p>
        <p className={styles.impressionSource}>{moment.media}</p>
        <div className={styles.feedActions}>
          <button type="button">Look through this view</button>
          <button type="button" onClick={() => setActive((active + 1) % moments.length)}>Next impression →</button>
        </div>
      </article>
    </div>
  );
}
