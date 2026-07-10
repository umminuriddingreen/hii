import type { View } from "../../app/views";
import { viewLabels } from "../../app/views";
import type { Machine } from "../../types/machine";
import type { Project } from "../../types/project";
import { MachineStatusDot } from "../fleet/MachineStatusDot";
import { pct } from "../../lib/format";

const navOrder: View[] = ["fleet", "jobs", "projects", "browser", "settings"];

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="px-3 pb-1 pt-4 text-[10px] uppercase tracking-wider text-ink-faint">
      {children}
    </div>
  );
}

export function Sidebar({
  view,
  onNavigate,
  machines,
  projects,
}: {
  view: View;
  onNavigate: (v: View) => void;
  machines: Machine[];
  projects: Project[];
}) {
  return (
    <aside className="flex flex-col overflow-auto border-r border-edge bg-panel">
      <nav className="pt-2">
        {navOrder.map((v) => (
          <button
            key={v}
            onClick={() => onNavigate(v)}
            className={`block w-full px-3 py-1.5 text-left text-xs ${
              view === v
                ? "border-l-2 border-accent bg-panel-2 font-medium text-ink"
                : "border-l-2 border-transparent text-ink-dim hover:text-ink"
            }`}
          >
            {viewLabels[v]}
          </button>
        ))}
      </nav>

      <SectionTitle>Machines</SectionTitle>
      <ul>
        {machines.map((m) => (
          <li
            key={m.id}
            className="flex items-center gap-2 px-3 py-1 text-xs text-ink-dim"
          >
            <MachineStatusDot status={m.status} />
            <span className="flex-1 truncate">{m.name}</span>
            <span className="font-mono text-[10px] text-ink-faint">
              {m.status === "offline" ? "—" : pct(m.cpuPercent)}
            </span>
          </li>
        ))}
      </ul>

      <SectionTitle>Projects</SectionTitle>
      <ul className="pb-3">
        {projects.map((p) => (
          <li key={p.id} className="truncate px-3 py-1 text-xs text-ink-dim">
            {p.name}
          </li>
        ))}
      </ul>
    </aside>
  );
}
