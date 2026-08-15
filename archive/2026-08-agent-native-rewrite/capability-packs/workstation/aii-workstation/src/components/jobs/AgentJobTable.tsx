import type { AgentTask } from "../../types/agentTask";
import type { Machine } from "../../types/machine";
import type { Project } from "../../types/project";
import { AgentJobRow } from "./AgentJobRow";

export function AgentJobTable({
  tasks,
  projects,
  machines,
  selectedId,
  onSelect,
}: {
  tasks: AgentTask[];
  projects: Project[];
  machines: Machine[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-auto rounded-md border border-edge bg-panel">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-edge text-[10px] uppercase tracking-wider text-ink-faint">
            <th className="px-3 py-2 font-medium">Task</th>
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Machine</th>
            <th className="px-3 py-2 font-medium">Agent</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <AgentJobRow
              key={t.id}
              task={t}
              project={projects.find((p) => p.id === t.projectId)}
              machine={machines.find((m) => m.id === t.machineId)}
              selected={t.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
