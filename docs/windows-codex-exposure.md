# HII PC Exposure Setup

## Goal

Turn the Windows PC into a machine HII can reach and operate through:

1. SSH control over Tailscale
2. Codex running reliably on the PC
3. Optional browser remote pane for full UI access

The stable path is:

`Windows host -> WSL Ubuntu -> Codex CLI`

and

`Mac HII -> Tailscale -> Windows OpenSSH -> WSL/Codex`

## Why This Architecture

- OpenAI's Codex CLI officially supports macOS and Linux; Windows support may require WSL.
- That makes WSL the correct runtime for Codex on the PC.
- Windows OpenSSH gives HII a deterministic control plane.
- Browser remoting should be a second layer, not the first one.

Official references:

- OpenAI Codex CLI getting started:
  https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started
- Codex CLI sign-in:
  https://help.openai.com/en/articles/11381614-codex-codex-andsign-in-with-chatgpt

## Phase 1: Prepare Windows

Run in **PowerShell as Administrator**:

```powershell
wsl --install -d Ubuntu

Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

if (!(Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" `
    -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True `
    -Direction Inbound `
    -Protocol TCP `
    -Action Allow `
    -LocalPort 22
}
```

Verify:

```powershell
Get-Service sshd
tailscale ip -4
tailscale status
```

The Windows Tailscale IP you gave for the PC is:

```text
100.81.69.126
```

## Phase 2: Install Codex in WSL

Inside **Ubuntu in WSL**:

```bash
sudo apt update
sudo apt install -y curl git build-essential

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

npm install -g @openai/codex
codex login
```

Test:

```bash
codex --version
codex
```

## Phase 3: Give HII an SSH Path to the PC

From the Mac, once SSH is reachable:

```bash
cd /Users/ummi/hii
npm run build

node dist/cli.js remote ssh add \
  --name "pc" \
  --host "100.81.69.126" \
  --user "<windows-username>" \
  --port 22 \
  --auth agent

node dist/cli.js remote ssh test pc
node dist/cli.js remote ssh exec pc --cmd "hostname"
```

## Phase 4: Reach Codex Through Windows + WSL

Once SSH works, HII can use Windows as the jump host and WSL as the Codex runtime.

Examples:

```bash
node dist/cli.js remote ssh exec pc --cmd "wsl.exe -d Ubuntu -- bash -lc 'pwd && node -v && codex --version'"
```

Run Codex inside a repo:

```bash
node dist/cli.js remote ssh exec pc --cmd "wsl.exe -d Ubuntu -- bash -lc 'cd ~/projects/<repo> && codex'"
```

Run a one-shot Codex task:

```bash
node dist/cli.js remote ssh exec pc --cmd "wsl.exe -d Ubuntu -- bash -lc 'cd ~/projects/<repo> && codex exec --skip-git-repo-check \"Explain this repo and propose the next 3 highest-leverage fixes.\"'"
```

## Phase 5: Optional Browser Remote Pane

If you want the live Windows UI inside HII, add a browser-capable remote layer.

Recommended later:

1. Install a VNC server on Windows
2. Expose it via noVNC/websockify on the PC or another node in the tailnet
3. Register it in HII

Example:

```bash
node dist/cli.js remote windows add \
  --name "pc-ui" \
  --provider novnc \
  --host "100.81.69.126" \
  --port 6080

node dist/cli.js remote windows session pc-ui --port 8787
```

## What Success Looks Like

Minimum viable exposure:

- Windows PC is online in Tailscale
- `sshd` is running on Windows
- WSL Ubuntu is installed
- Codex CLI runs in WSL
- HII can test and execute SSH commands against the machine

Full exposure:

- HII has SSH control
- HII has browser-pane access to the Windows UI
- HII can route work to the PC as a remote execution node

## Fast Debug Checklist

If HII cannot reach the PC:

```powershell
Get-Service sshd
tailscale status
tailscale ip -4
```

From the Mac:

```bash
tailscale ping 100.81.69.126
ssh <windows-username>@100.81.69.126
```

If Codex fails in Windows directly, use WSL instead.

If browser remoting fails, keep SSH as the primary control path and treat the UI stream as optional until it is stable.
