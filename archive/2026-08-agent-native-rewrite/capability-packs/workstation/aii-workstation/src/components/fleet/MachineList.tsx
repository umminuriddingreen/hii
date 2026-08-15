import type { Machine } from "../../types/machine";
import { MachineCard } from "./MachineCard";

export function MachineList({ machines }: { machines: Machine[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {machines.map((m) => (
        <MachineCard key={m.id} machine={m} />
      ))}
    </div>
  );
}
