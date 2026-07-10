export type MachineStatus = "online" | "busy" | "offline" | "error";

export type Machine = {
  id: string;
  name: string;
  os: string;
  host: string;
  sshUser: string;
  status: MachineStatus;
  cpuPercent: number;
  ramPercent: number;
  diskPercent: number;
  gpuPercent?: number;
  activeAgentCount: number;
  lastHeartbeat: string;
  defaultWorktreeRoot: string;
  tags: string[];
};

/** Live metrics snapshot — Phase 2 will populate this from `sysinfo` on the Rust side. */
export type MachineMetrics = {
  machineId: string;
  cpuPercent: number;
  ramPercent: number;
  diskPercent: number;
  gpuPercent?: number;
  processCount: number;
  uptimeSeconds: number;
  hostname: string;
};
