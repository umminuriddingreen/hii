'use client';

import { useState } from 'react';

type Location = { label: string; latitude: number; longitude: number };
const OAKLAND: Location = { label: 'Dropped pin', latitude: 37.79965, longitude: -122.30263 };

export function WaymarkApp({ destination, onPayload }: { destination: string; onPayload: (patch: Record<string, unknown>) => void }) {
  const [location, setLocation] = useState(OAKLAND);
  const [query, setQuery] = useState('Oakland, CA');
  const [notice, setNotice] = useState('Preview only · no device executor enrolled');
  const search = () => {
    setLocation(OAKLAND);
    setNotice(`Pinned ${query || 'Oakland, CA'} for preview`);
  };
  const apply = () => {
    const proposedAt = new Date().toISOString();
    onPayload({ proposedLocation: location, proposedAt, simulated: true });
    setNotice('Proposal saved · real device change still requires an enrolled executor and approval');
  };
  return (
    <section className="waymark-app">
      <aside><header><i>⌁</i><strong>Waymark</strong></header><nav><button className="active">⌖ <span>Location</span></button><button>⌁ <span>Routes</span></button><button>◆ <span>Bookmarks</span></button><button>◷ <span>History</span></button></nav><footer><b>HII canvas</b><span>{destination}</span><small>location executor · not enrolled</small></footer></aside>
      <main>
        <form onSubmit={(event) => { event.preventDefault(); search(); }}><span>⌕</span><input aria-label="Search locations" value={query} onChange={(event) => setQuery(event.target.value)} /><button>Search</button></form>
        <div className="waymark-map" role="img" aria-label="Stylized map of Oakland with a dropped pin"><span className="waymark-water">SAN FRANCISCO BAY</span><span className="waymark-city">Oakland</span><span className="waymark-road road-a" /><span className="waymark-road road-b" /><span className="waymark-road road-c" /><button className="waymark-pin" aria-label="Dropped pin">●<small>{location.label}</small></button></div>
        <section className="waymark-card"><header><strong>{location.label}</strong><span>PROPOSAL</span></header><div><label>Latitude<input type="number" step="0.00001" value={location.latitude} onChange={(event) => setLocation({ ...location, latitude: Number(event.target.value) })} /></label><label>Longitude<input type="number" step="0.00001" value={location.longitude} onChange={(event) => setLocation({ ...location, longitude: Number(event.target.value) })} /></label></div><button onClick={apply}>Use this location</button><p>{notice}</p></section>
      </main>
    </section>
  );
}
