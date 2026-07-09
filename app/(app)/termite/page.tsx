import Link from 'next/link';
import { getUser } from '@/lib/supabase/server';
import { InstallerAssistant } from './InstallerAssistant';
import { ManagedTerminal } from './ManagedTerminal';

const downloadHref = '/downloads/termite-alpha-macos.zip';

const installSteps = [
  'Download the Termite alpha package.',
  'Unzip it and keep the release folder somewhere easy to find.',
  'Install the Rhino bridge from the staged Yak/plugin contents.',
  'Open or restart Rhino 8.',
  'Run StartTermiteBridge in the Rhino command line.',
  'Start the MCP server with EDIT_SAFE permission for geometry tests.',
  'Run the doctor check and confirm rhino.ping passes.'
];

const updateSteps = [
  'Download the newest alpha package from this page.',
  'Quit Rhino 8 before replacing the bridge files.',
  'Replace the prior Termite release folder with the new release folder.',
  'Reinstall the Rhino bridge, then reopen Rhino.',
  'Run StartTermiteBridge again after every update.',
  'Run the doctor check before testing client geometry.'
];

const scaleSteps = [
  'Managed alpha: you run Termite on this Mac for trusted clients and log every job in HII.',
  'Provisioned install: HII guides a user through local setup with the installer manager.',
  'Tracked service: each launch becomes a job with budget, status, logs, proof, and deliverables.',
  'Fleet mode: AII can route jobs to a secure VPS, Mac worker, or client machine when demand grows.',
  'Commerce layer: HII turns repeatable capability into subscriptions, pilots, items, and approved proof.'
];

export default async function TermiteAlphaPage() {
  const user = await getUser();

  return (
    <div className="hii-page space-y-12">
      <section className="hii-page-header">
        <p className="hii-kicker">Termite alpha</p>
        <h1 className="hii-page-title">
          Provisioned AI automation for Rhino 8.
        </h1>
        <p className="hii-page-copy">
          Termite is the first HII capability item: a managed agent workflow that can
          inspect Rhino documents, create test geometry, capture proof, and turn the
          result into a tracked client job. Start on this Mac, then scale the same
          install/run/update sequence across secure workers and client machines.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href={downloadHref}
            className="hii-command-button"
          >
            Download alpha zip
          </a>
          <Link
            href="/"
            className="hii-secondary-action"
          >
            Back to HII
          </Link>
        </div>

        <p className="mt-4 text-xs text-neutral-400">
          macOS alpha package · 373 KB · SHA-256 582dc87e1a59e3b6907d11675b2ea611b190ac14d3e98b695f4a7ad57f2dc70d
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Install Sequence</h2>
        <ol className="mt-4 space-y-3">
          {installSteps.map((step) => (
            <li key={step} className="hii-card">
              {step}
            </li>
          ))}
        </ol>

        <div className="hii-terminal-frame mt-5 p-4 font-mono text-sm">
          <p>cd /path/to/Termite</p>
          <p>npm run build</p>
          <p>npm run install:rhino-mac</p>
          <p>RHINO_MCP_PERMISSION=EDIT_SAFE node apps/mcp-server/dist/index.js doctor</p>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Update Sequence</h2>
        <ol className="mt-4 space-y-3">
          {updateSteps.map((step) => (
            <li key={step} className="hii-card">
              {step}
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-[var(--hii-electric-blue)] pt-8">
        <h2 className="text-xl font-semibold">Scale Path</h2>
        <ol className="mt-4 space-y-3">
          {scaleSteps.map((step) => (
            <li key={step} className="hii-card">
              {step}
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-[var(--hii-electric-blue)] pt-8">
        <h2 className="text-xl font-semibold">Current Alpha Boundary</h2>
        <p className="mt-3 text-neutral-600">
          The bridge and MCP server are ready for a Rhino 8 alpha test. Use tracked,
          reversible geometry workflows first. Grasshopper and broad scripting are not the
          first test target. If doctor fails on document tools, open a blank Rhino document
          and rerun the bridge check.
        </p>
      </section>

      <InstallerAssistant />

      <ManagedTerminal signedIn={Boolean(user)} />
    </div>
  );
}
