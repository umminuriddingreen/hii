# HII UI channel — ship interface work without rebuilding the app

The Tauri shell (Rust binary, IPC commands, entitlements, notarization) is the
slow part. The interface is a static Next export, so it is swapped underneath the
shell at runtime instead of being frozen into the bundle.

The main window resolves its interface source in this order:

1. `HII_UI_URL` — a live dev server. Highest priority, always wins.
2. `~/.hii/ui/state.json` with `"mode": "live"` — the same, made sticky.
3. `~/.hii/ui/bundles/<version>` — an installed bundle, served over the
   `hiiui://` scheme (`http://hiiui.localhost` on Windows).
4. The interface baked into the app bundle (unchanged default).

## Developing against the installed app (HMR)

```bash
npm run ui:live        # writes live mode, then runs next dev on 3042
                       # relaunch HII: it loads the dev server with HMR
npm run ui:status
npm run ui:live:off    # back to the installed/baked interface
```

`ui:live` restores the previous mode when the dev server exits. One-off:
`HII_UI_URL=http://127.0.0.1:3042 open -a HII`.

## Shipping an interface-only release

```bash
export TAURI_SIGNING_PRIVATE_KEY=...            # the desktop updater key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
npm run ui:release -- --version 0.1.4 --base-url https://<host>/ui
npm run ui:publish
```

That builds `out/`, zips it, signs it, and writes `dist/ui/ui-latest.json`.
`ui:publish` refuses unsigned bundles and uploads the zip plus manifest to HII's
canonical R2-backed endpoint at `https://humaninformationinterface.com/ui/`.
Installed apps polling that endpoint pick the release up — no rebuild, no
reinstall, no notarization.

## Wiring an app to the channel

From the interface (`lib/client/hii-ui-channel.ts`):

```ts
await configureUiChannel({ endpoint: 'https://<host>/ui/ui-latest.json', autoApply: false });
const unlisten = await listenUiChannel((event) => { /* prompt on update-available */ });
await applyUiChannel();          // swap + reload, no restart
await listUiChannelVersions();   // roll back to any installed version
```

With `autoApply: true` the poller installs and reloads on its own. With it off,
the bundle is staged and `hii://ui-update-available` fires so the interface can
ask first.

## Trust

A UI bundle is code with full IPC access, so it is only installed when its
sha256 matches the manifest **and** its minisign signature verifies against the
same public key the desktop updater trusts. Manifest and bundle URLs must be
https (loopback allowed for local testing). Unsigned bundles are refused unless
`HII_UI_ALLOW_UNSIGNED=1` is set for local testing. Archive entries and asset
paths are checked against traversal; a zip that lands without `index.html` is
discarded and the previous bundle stays active.

## What still needs a real rebuild

Anything in the shell: new IPC commands, Rust changes, entitlements, plugins,
icons, bundle metadata. Interface bundles run against the shell's existing
command surface, so ship a shell release first when a feature needs a new one.
