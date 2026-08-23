# Install HII

HII runs as a local desktop app on Apple Silicon Macs with macOS 13 or newer and on x64 Windows 10 or 11 PCs. The app includes its own local HII server. It does not require the source repository and stores your HII state in your user profile under `.hii`.

## Windows 10 or 11

1. Download the Windows installer from the HII website.
2. Open the downloaded `HII-*-windows-x64-setup.exe` file.
3. Finish the current-user installation. Administrator access is not required.
4. Open **HII** from the Start menu.

The installer includes the WebView2 bootstrapper HII needs for its desktop interface. A public release should identify a verified publisher in Windows; do not weaken Windows Security or SmartScreen for an unexpected or unverified file.

## macOS 13 or newer

The public Mac download remains closed until Apple Developer ID signing and notarization pass. When the notarized disk image is available:

1. Download `HII-<version>-macos-aarch64.dmg` and open it.
2. Drag **HII** onto the **Applications** shortcut in the same window.
3. Eject the disk image and open HII from Applications.
4. If macOS blocks a build that is supposed to be notarized, stop and report it. Do not disable Gatekeeper.

HII updates itself after that. It checks for a new version on launch, shows a notice in the
corner, and installs only when you choose to. Every update is verified against HII's signing
key before it is applied; an update that fails verification is refused.

### Building it yourself

Anyone with the repository can build and install the app without an Apple account:

```bash
npm run build:tauri:dmg   # produces src-tauri/target/release/bundle/dmg/
npm run install:tauri     # or build the .app and copy it to /Applications
```

A locally built app is ad-hoc signed. It runs on the machine that built it, but macOS will
refuse it if it is copied to another Mac — that is what Developer ID signing is for.

## Connect an agent

HII detects agents already installed on the computer. It does not install them or handle their account credentials.

- **Codex:** run `codex login`, finish sign-in, then use **Check again** in HII.
- **Claude Code:** run `claude`, finish sign-in, then use **Check again** in HII.
- **Ollama:** local use needs no account, but the activation beta still requires an authenticated Codex executor for a verified first run.

HII will not continue activation until the chosen agent is installed and signed in. Choose one specific project folder containing at least one supported file; HII never infers access to your whole home directory.

## First use

Open **Activate**, choose the agent, choose a project folder, review the included files, and state one bounded task. The first run is complete only when HII returns a verified receipt.

## Troubleshooting

### An agent is not detected

Quit and reopen HII after installing or signing in to the agent. Confirm its command works in Terminal or PowerShell (`codex`, `claude`, or `ollama`), then select **Check again**.

### AII is offline

Open the AII health control in the workspace and choose **Start AII**. The packaged app contains this runtime; a source checkout should not be required. If startup still fails, use the error shown there when reporting the problem.

### Uninstall

- **Windows:** uninstall HII from **Settings → Apps → Installed apps**.
- **macOS:** quit HII and move `/Applications/HII.app` to Trash.

Application removal intentionally leaves `.hii` in your user profile so an update or reinstall keeps your work. Deleting that folder permanently removes local HII state, logs, activations, and run history; copy anything you need before deleting it.
