# Install HII on your Mac

HII is designed for Apple Silicon Macs running macOS 13 or newer. You will receive a signed `HII.app` and a bootstrap script named `hii-bootstrap.sh`. The bootstrap does not use administrator access, install other agents, or connect to the internet.

## 1. Drag HII.app to Applications

Open the folder or disk image you received. Drag **HII.app** into the **Applications** folder. Wait for the copy to finish before opening it.

## 2. Open HII for the first time

Open **Applications**, right-click **HII**, and choose **Open**. In the confirmation window, choose **Open** again. This right-click path is useful on a Mac that has not seen this HII build before.

For a notarized build, macOS checks the app and then opens it normally. You may see a short “Verifying HII” message on the first launch. You should not need to weaken Gatekeeper or change your Mac's general security settings.

## 3. Run the bootstrap

The bootstrap script is supplied alongside the app. Open Terminal, type `cd ` (including the space), drag the folder containing `hii-bootstrap.sh` into the Terminal window, and press Return. Then run:

```sh
bash hii-bootstrap.sh
```

The script checks compatibility, prepares HII's private local folders, reports which supported agents it can see, and configures the optional local daemon. It is safe to run again. By default, it writes the daemon configuration but does not load it; follow the command printed at the end if you want the daemon to start automatically.

## 4. Connect your agent

HII works with an agent already installed on your Mac. The bootstrap detects agents but never installs, launches, or signs in to them.

- **Codex:** run `codex login` in Terminal and complete the sign-in prompts. See the official OpenAI Codex documentation if your organization uses a different login method.
- **Claude:** run `claude` in Terminal, then follow its login or authentication prompts. See the official Anthropic Claude Code documentation for current account and authentication options.
- **Ollama:** an account is not required for local use. If your partner package calls for Ollama, run `bash hii-bootstrap.sh --with-ollama` to print the exact optional setup commands. The bootstrap will not run them for you.

## 5. Activate HII

Open **HII** from Applications. Go to the **Activate** screen, select the agent you connected, and follow the on-screen check. HII keeps runtime state on this Mac under `~/.hii`.

## 6. Troubleshooting

### Gatekeeper blocks HII

Confirm that HII is in Applications. Right-click **HII**, choose **Open**, then choose **Open** in the confirmation window. If macOS still blocks the app, open **System Settings → Privacy & Security**, find the message about HII, and use **Open Anyway** only if the app came directly from your HII design-partner package. Do not disable Gatekeeper globally.

### An agent is not detected

Quit and reopen Terminal after installing the agent, then run `bash hii-bootstrap.sh` again. HII checks your normal command path and `/opt/homebrew/bin`. Confirm the agent's own command works in Terminal (`codex`, `claude`, or `ollama`) and complete its vendor login flow if needed. The bootstrap intentionally does not install or start agents.

### The daemon is not running

The bootstrap does not load the daemon by default. Run:

```sh
launchctl load ~/Library/LaunchAgents/com.ummi.hii.hiid.plist
```

Or run `bash hii-bootstrap.sh --enable-daemon`. If the plist was not created, confirm that the complete partner build is installed at `/Applications/HII.app`, then run the bootstrap again.

### Fully uninstall HII

First quit HII. If the daemon was enabled, unload it:

```sh
launchctl unload ~/Library/LaunchAgents/com.ummi.hii.hiid.plist
```

Then remove these three paths:

- `/Applications/HII.app` — the application
- `~/.hii` — all local HII runtime state, logs, activations, traces, skills, and run history
- `~/Library/LaunchAgents/com.ummi.hii.hiid.plist` — the per-user daemon configuration

Deleting `~/.hii` permanently removes your local HII state. Copy anything you need from it before uninstalling.
