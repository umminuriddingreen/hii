import type { Project } from "../../types/project";
import type { Machine } from "../../types/machine";
import type { AgentTask } from "../../types/agentTask";
import { ProjectCard } from "./ProjectCard";

export function ProjectRegistry({
  projects,
  machines,
  tasks,
}: {
  projects: Project[];
  machines: Machine[];
  tasks: AgentTask[];
}) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {projects.map((p) => (
        <ProjectCard
          key={p.id}
          project={p}
          machine={machines.find((m) => m.id === p.defaultMachineId)}
          taskCount={tasks.filter((t) => t.projectId === p.id).length}
        />
      ))}
    </div>
  );
}
