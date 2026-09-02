// SPDX-License-Identifier: LicenseRef-BSL-1.1
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'How HII connects information, actions, results, and proof on your own machine.',
  alternates: { canonical: '/docs' }
};

export default function DocsPage() {
  return (
    <main className="public-home" id="hii-main">
      <p className="public-name">HII / Documentation</p>
      <h1>Human information, agent capability.</h1>
      <p>
        HII is one persistent canvas. Information, the actions you take on it, the results, and
        the proof of what happened all live in the same place, on your own machine.
      </p>

      <section id="canvas">
        <h2>The canvas</h2>
        <p>
          An infinite surface holding objects: notes, files, images, web pages, terminals and
          agent runs. Drag to pan, scroll to zoom, and drop anything onto it. Objects keep their
          position, so the canvas stays a place you recognise rather than a list you scroll.
        </p>
        <p>
          Press <kbd>&#8984;K</kbd> to say what should happen. HII answers into an object on the
          canvas, streaming as it goes, and that object stays — the answer and what produced it
          remain side by side.
        </p>
      </section>

      <section id="terminals">
        <h2>Terminals and agents</h2>
        <p>
          Any object can be a real terminal, running your shell in a pseudo-terminal with your
          environment. Agents run in the same way: you can watch the work happen and read the
          output afterwards, because the run is an object on the canvas and not a transcript
          that disappears.
        </p>
      </section>

      <section id="workspaces">
        <h2>Local documents and account workspaces</h2>
        <p>
          The desktop app opens on the Runtime document under <code>~/.hii</code>. It is local,
          it is the default, and nothing about it is uploaded.
        </p>
        <p>
          An account workspace is the opt-in alternative, chosen in the workspace panel. It is
          stored with your account and synchronised between the devices you have linked, so the
          same canvas is in front of you on a Mac, a PC and in the browser. Only the document
          syncs; images and other media stay on the machine that holds them.
        </p>
      </section>

      <section id="devices">
        <h2>Linking a device</h2>
        <p>
          Sign in on the web with your passkey, generate a device code, and enter it in the
          desktop app or run <code>hii login</code>. The code is valid for fifteen minutes and
          is exchanged once for a credential stored at{' '}
          <code>~/.hii/account/device.json</code>. The app never holds your passkey, and a
          device can be revoked without touching the others.
        </p>
      </section>

      <section id="cli">
        <h2>The command line</h2>
        <p>
          <code>hii</code> ships inside the desktop app and works on its own. <code>hii home</code>{' '}
          reports where things stand, <code>hii work</code> shows what is in flight, and{' '}
          <code>hii agents guide</code> prints the contract an agent is expected to follow.
        </p>
      </section>

      <nav><a href="/">Home</a><a href="/download">Download</a><a href="/privacy">Privacy</a></nav>
    </main>
  );
}
