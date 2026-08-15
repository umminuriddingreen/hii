import type { AgentTask } from "../../types/agentTask";
import type { Machine } from "../../types/machine";
import type { Project } from "../../types/project";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { agentToolLabel } from "../../lib/status";
import { timeAgo } from "../../lib/format";

export function AgentJobRow({
  task,
  project,
  machine,
  selected,
  onSelect,
}: {
  task: AgentTask;
  project?: Project;
  machine?: Machine;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <tr
      onClick={() => onSelect(task.id)}
      className={`cursor-pointer border-b border-edge-soft text-xs ${
        selected ? "bg-accent/5" : "hover:bg-panel-2"
      }`}
    >
      <td className="px-3 py-2">
        <div className="font-medium text-ink">{task.title}</div>
        <div className="mt-0.5 font-mono text-[11px] text-ink-faint">
          {task.branchName}
        </div>
      </td>
      <td className="px-3 py-2 text-ink-dim">{project?.name ?? "—"}</td>
      <td className="px-3 py-2 text-ink-dim">{machine?.name ?? "—"}</td>
      <td className="px-3 py-2 text-ink-dim">{agentToolLabel[task.agentTool]}</td>
      <td className="px-3 py-2">
        <AgentStatusBadge status={task.status} />
      </td>
      <td className="px-3 py-2 text-right text-ink-faint">
        {timeAgo(task.updatedAt)}
      </td>
    </tr>
  );
}
