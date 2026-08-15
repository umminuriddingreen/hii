import type { MachineStatus } from "../../types/machine";
import { machineStatusColor } from "../../lib/status";

export function MachineStatusDot({ status }: { status: MachineStatus }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${machineStatusColor[status]}`}
      title={status}
    />
  );
}
