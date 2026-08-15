import type { AgentTask } from "../../types/agentTask";
import type { Machine } from "../../types/machine";
import type { Project } from "../../types/project";
import { Button } from "../ui/Button";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { agentToolLabel } from "../../lib/status";
import { timeAgo } from "../../lib/format";
import { stopAgentTask, restartAgentTask } from "../../lib/api";

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div
        className={`mt-0.5 break-all text-xs ${mono ? "font-mono text-ink-dim" : "text-ink"}`}
      >
        {value}
      </div>
    </div>
  );
}

export function AgentJobDetail({
  task,
  project,
  machine,
}: {
  task: AgentTask | null;
  project?: Project;
  machine?: Machine;
}) {
  if (!task) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-ink-faint">
        Select a job to inspect it
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold leading-tight">{task.title}</h2>
          <AgentStatusBadge status={task.status} />
        </div>
        <div className="mt-1 text-[11px] text-ink-faint">
          {project?.name ?? "—"} · {machine?.name ?? "—"} ·{" "}
          {agentToolLabel[task.agentTool]} · updated {timeAgo(task.updatedAt)}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {/* TODO(phase-5): Attach = copy/exec `tmux attach -t <sessionId>` over SSH */}
        <Button>Attach</Button>
        <Button variant="danger" onClick={() => stopAgentTask(task.id)}>
          Stop
        </Button>
        <Button onClick={() => restartAgentTask(task.id)}>Restart</Button>
        {/* TODO(phase-8): Open Diff = `gh pr diff` / local git diff view */}
        <Button>Open Diff</Button>
        <Button disabled={!task.prUrl}>Open PR</Button>
      </div>

      <div className="grid grid-cols-1 gap-2.5 border-t border-edge-soft pt-3">
        <Field label="Branch" value={task.branchName} mono />
        <Field label="Worktree" value={task.worktreePath} mono />
        <Field label="Session" value={task.sessionId} mono />
        <Field label="Repo" value={task.repoPath} mono />
        {task.prUrl && <Field label="Pull Request" value={task.prUrl} mono />}
      </div>

      <div className="border-t border-edge-soft pt-3">
        <div className="text-[10px] uppercase tracking-wider text-ink-faint">Prompt</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">{task.prompt}</p>
      </div>
    </div>
  );
}
