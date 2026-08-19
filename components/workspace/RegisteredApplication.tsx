'use client';

export function RegisteredApplication({ name, summary, entryUrl }: { name: string; summary: string; entryUrl?: string }) {
  if (entryUrl) {
    return (
      <section className="hii-registered-app">
        <header><strong>{name}</strong><span>Sandboxed HII application</span></header>
        <iframe
          title={name}
          src={entryUrl}
          sandbox="allow-forms allow-scripts allow-downloads"
          referrerPolicy="no-referrer"
        />
      </section>
    );
  }
  return (
    <section className="hii-registered-app hii-registered-app-unavailable">
      <span>APP SURFACE</span>
      <h2>{name}</h2>
      <p>{summary}</p>
      <small>This manifest is registered, but its bundled canvas adapter is not installed in this HII build.</small>
    </section>
  );
}
