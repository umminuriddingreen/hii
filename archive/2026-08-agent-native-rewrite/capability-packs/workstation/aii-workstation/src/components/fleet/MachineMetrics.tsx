import type { Machine } from "../../types/machine";
import { MetricBar } from "../ui/MetricBar";

export function MachineMetrics({ machine }: { machine: Machine }) {
  return (
    <div className="flex flex-col gap-1.5">
      <MetricBar label="cpu" percent={machine.cpuPercent} />
      <MetricBar label="ram" percent={machine.ramPercent} />
      <MetricBar label="disk" percent={machine.diskPercent} />
      {machine.gpuPercent !== undefined && (
        <MetricBar label="gpu" percent={machine.gpuPercent} />
      )}
    </div>
  );
}
