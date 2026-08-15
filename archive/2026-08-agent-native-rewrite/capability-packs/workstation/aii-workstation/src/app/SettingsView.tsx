import { Card } from "../components/ui/Card";

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-edge-soft py-2 text-xs last:border-0">
      <span className="text-ink-dim">{label}</span>
      <span className="font-mono text-ink">{value}</span>
    </div>
  );
}

export function SettingsView() {
  return (
    <div className="max-w-2xl space-y-3">
      <Card>
        <h3 className="mb-1 text-sm font-semibold">Defaults</h3>
        <Setting label="Default agent tool" value="claude_code" />
        <Setting label="Default worktree root" value="~/aii/worktrees" />
        <Setting label="Session naming" value="aii__{project}__{task}" />
        <Setting label="Branch naming" value="agent/{task}" />
      </Card>

      <Card>
        <h3 className="mb-1 text-sm font-semibold">Built-in surfaces</h3>
        <Setting label="Embedded terminal (local PTY)" value="active" />
        <Setting label="Helium internal browser" value="active" />
      </Card>

      <Card>
        <h3 className="mb-1 text-sm font-semibold">Integrations (planned)</h3>
        {/* Each row lands in a later phase — see README roadmap */}
        <Setting label="SSH (safe test commands)" value="phase 4" />
        <Setting label="tmux / Zellij sessions" value="phase 5" />
        <Setting label="Git worktree automation" value="phase 6" />
        <Setting label="Agent launch (Codex / Claude Code)" value="phase 7" />
        <Setting label="GitHub CLI PR tracking" value="phase 8" />
        <Setting label="SQLite machine registry" value="phase 3" />
        <Setting label="KVM / Fingerbot / Wake-on-LAN recovery" value="phase 9" />
        <Setting label="Tailscale status" value="phase 9" />
      </Card>
    </div>
  );
}
