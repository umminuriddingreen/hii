'use client';

export function AliveBars({ compact = false }: { compact?: boolean }) {
  const bars = compact ? 3 : 5;

  return (
    <div
      aria-label="alive"
      className={`hii-alive-bars ${compact ? 'hii-alive-bars-compact' : ''}`}
    >
      {Array.from({ length: bars }).map((_, index) => (
        <span key={index} style={{ animationDelay: `${index * 120}ms` }} />
      ))}
    </div>
  );
}
