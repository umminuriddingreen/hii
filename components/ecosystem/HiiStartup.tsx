import styles from './HiiAppShell.module.css';

export function HiiStartup({
  sessionReady,
  catalogReady
}: {
  sessionReady: boolean;
  catalogReady: boolean;
}) {
  const ready = sessionReady && catalogReady;
  return (
    <main className={styles.startup} aria-label="Starting HII" aria-busy={!ready}>
      <div className={styles.startupField} aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>
      <section>
        <div className={styles.startupMark} aria-hidden="true"><span /><span /><span /></div>
        <p>Human Information Interface</p>
        <h1>HII</h1>
        <ul aria-label="Startup checks">
          <li data-ready={sessionReady || undefined}><i /> Owner boundary</li>
          <li data-ready={catalogReady || undefined}><i /> Local objects</li>
          <li data-ready={ready || undefined}><i /> Information surface</li>
        </ul>
      </section>
      <footer>{ready ? 'Ready on this device' : 'Opening your local surface'}</footer>
    </main>
  );
}
