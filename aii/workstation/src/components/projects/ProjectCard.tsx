import type { Project } from "../../types/project";
import type { Machine } from "../../types/machine";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { agentToolLabel } from "../../lib/status";

export function ProjectCard({
  project,
  machine,
  taskCount,
}: {
  project: Project;
  machine?: Machine;
  taskCount: number;
}) {
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">{project.name}</span>
        <Badge className="border-edge bg-panel-2 text-ink-dim">
          {agentToolLabel[project.preferredAgent]}
        </Badge>
      </div>
      <div className="space-y-1 font-mono text-[11px] text-ink-dim">
        <div className="break-all">{project.repoUrl}</div>
        <div>{project.localPath}</div>
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-ink-faint">
        <span>
          branch <span className="font-mono text-ink-dim">{project.defaultBranch}</span>
        </span>
        <span>{machine?.name ?? "no default machine"}</span>
        <span>
          tasks <span className="font-mono text-ink-dim">{taskCount}</span>
        </span>
      </div>
    </Card>
  );
}
