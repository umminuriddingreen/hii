export default function DownloadPage() {
  return (
    <main className="public-home">
      <p className="public-name">HII / Download</p>
      <h1>HII for Mac.</h1>
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
        The public download opens once Apple Developer ID signing and notarization pass. Until
        then you can build it from source; see the installation guide.
      </p>
      <nav><a href="/">Home</a><a href="/docs">Documentation</a></nav>
    </main>
  );
}
