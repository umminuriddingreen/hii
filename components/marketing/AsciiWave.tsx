// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect, useState } from 'react';
import { asciiWaveFrame } from './ascii-wave';

export { asciiWaveFrame } from './ascii-wave';

export function AsciiWave({ className = '' }: { className?: string }) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    const timer = window.setInterval(() => setPhase((value) => value + 0.17), 90);
    return () => window.clearInterval(timer);
  }, []);

  return <pre className={className} aria-hidden="true">{asciiWaveFrame(phase)}</pre>;
}
