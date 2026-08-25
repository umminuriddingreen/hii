export default function DownloadPage() {
  return (
    <main className="public-home">
      <p className="public-name">HII / Download</p>
      <h1>HII for Windows.</h1>
      <p>
        HII is a local canvas for a person and their agents. Windows can install it today. The Mac
        app is still closed while it waits on Apple.
      </p>
      <p>
        <strong>Windows.</strong> Available now. Every release build produces an installer that is
        smoke-tested from a clean machine before it counts. It is not yet code-signed, so Windows
        will warn you once on first run.
      </p>
      <p>
        <strong>Mac.</strong> Apple Silicon, macOS 13 or newer. The disk image opens to the public
        once Apple Developer ID signing and notarization pass. Until then the Mac app is
        build-from-source only.
      </p>
      <p>
        <strong>The <code>hii</code> command line.</strong> Released for macOS and Linux, and the
        fastest way to see the runtime without waiting for the app. Every important operation in
        HII works through it first.
      </p>
      <p>
        Want it run against your own work instead? That is a session, and the result is yours to
        keep. Write to{' '}
        <a href="mailto:hello@humaninformationinterface.com">hello@humaninformationinterface.com</a>.
      </p>
      <nav><a href="/download/windows">Download for Windows</a><a href="/">Home</a><a href="/docs">Documentation</a></nav>
    </main>
  );
}
