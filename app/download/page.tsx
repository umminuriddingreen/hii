export default function DownloadPage() {
  return (
    <main className="public-home">
      <p className="public-name">HII / Download</p>
      <h1>HII for your computer.</h1>
      <p>The native HII canvas is planned as a Tauri desktop app for Mac and Windows.</p>
      <p>
        The browser account remains the canonical data source. Each installed app will keep an
        automatically synchronized local copy so work remains available on that computer.
      </p>
      <section id="mac">
        <h2>Mac</h2>
        <p>
        A local canvas for a person and their agents. Apple Silicon, macOS 13 or newer.
        Download the disk image, drag HII to Applications, and open it.
        </p>
        <p>
        HII keeps itself current after that. It checks for a new version on launch and installs
        only when you say so, and it verifies every update against HII&rsquo;s signing key before
        applying it.
        </p>
        <p>
        The Tauri app download opens once Apple Developer ID signing and notarization pass. Until
        then you can build it from source; see the installation guide.
        </p>
      </section>
      <section id="windows">
        <h2>Windows</h2>
        <p>
          The Windows Tauri build is planned. Its public installer will appear here only
          after the packaged app and update path pass release verification.
        </p>
      </section>
      <nav><a href="/">Home</a><a href="/docs">Documentation</a></nav>
    </main>
  );
}
