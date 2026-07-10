import type { Machine } from "../../types/machine";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { MachineStatusDot } from "./MachineStatusDot";
import { MachineMetrics } from "./MachineMetrics";
import { machineStatusLabel } from "../../lib/status";
import { timeAgo } from "../../lib/format";

export function MachineCard({ machine }: { machine: Machine }) {
  const offline = machine.status === "offline";
  return (
    <Card className={offline ? "opacity-60" : ""}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MachineStatusDot status={machine.status} />
          <span className="text-sm font-semibold">{machine.name}</span>
        </div>
        <span className="text-[11px] text-ink-faint">
          {machineStatusLabel[machine.status]} · {timeAgo(machine.lastHeartbeat)}
        </span>
      </div>
      <div className="mb-2 font-mono text-[11px] text-ink-dim">
        {machine.sshUser}@{machine.host}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <Badge className="border-edge bg-panel-2 text-ink-dim">
          {machine.os}
        </Badge>
        {machine.tags.map((t) => (
          <Badge key={t} className="border-edge bg-panel-2 text-ink-faint">
            {t}
          </Badge>
        ))}
      </div>
      <MachineMetrics machine={machine} />
      <div className="mt-3 flex items-center justify-between text-[11px] text-ink-faint">
        <span>
          agents:{" "}
          <span className="font-mono text-ink-dim">
            {machine.activeAgentCount}
          </span>
        </span>
        <span className="font-mono">{machine.defaultWorktreeRoot}</span>
      </div>
    </Card>
  );
}
