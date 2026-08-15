import type { View } from "../../app/views";
import { viewLabels } from "../../app/views";
import type { BackendStatus } from "../../lib/api";

export function Topbar({
  view,
  backend,
}: {
  view: View;
  backend: BackendStatus | null;
}) {
  const backendLabel = backend
    ? backend.available
      ? `hii · ${backend.taskCount} tasks · ${backend.projectCount} projects`
      : "hii offline"
    : "connecting…";

  return (
    <header className="flex items-center justify-between border-b border-edge bg-panel px-4">
      <div className="flex items-baseline gap-3">
        <span className="text-sm font-bold tracking-tight">
          AII <span className="text-accent">Agent Workstation</span>
        </span>
        <span className="text-[11px] text-ink-faint">{viewLabels[view]}</span>
      </div>
      <span
        className={`font-mono text-[10px] ${
          backend?.available ? "text-ok" : "text-warn"
        }`}
      >
        {backendLabel}
      </span>
    </header>
  );
}
