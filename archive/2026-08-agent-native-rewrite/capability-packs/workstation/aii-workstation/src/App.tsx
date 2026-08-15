import { useEffect, useMemo, useState } from "react";
import type { View } from "./app/views";
import type { Machine } from "./types/machine";
import type { Project } from "./types/project";
import type { AgentTask } from "./types/agentTask";
import {
  getMachines,
  getProjects,
  getAgentTasks,
  getBackendStatus,
  type BackendStatus,
} from "./lib/api";
import { AppShell } from "./components/layout/AppShell";
import { Topbar } from "./components/layout/Topbar";
import { Sidebar } from "./components/layout/Sidebar";
import { MachineList } from "./components/fleet/MachineList";
import { AgentJobTable } from "./components/jobs/AgentJobTable";
import { AgentJobDetail } from "./components/jobs/AgentJobDetail";
import { ProjectRegistry } from "./components/projects/ProjectRegistry";
import { BrowserView } from "./components/browser/BrowserView";
import { BottomDock } from "./components/logs/BottomDock";
import { SettingsView } from "./app/SettingsView";

export default function App() {
  const [view, setView] = useState<View>("jobs");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendStatus | null>(null);

  useEffect(() => {
    const refresh = () => {
      getBackendStatus().then(setBackend).catch(() => setBackend(null));
      getMachines().then(setMachines).catch(() => {});
      getProjects().then(setProjects).catch(() => {});
      getAgentTasks()
        .then((t) => {
          setTasks(t);
          setSelectedTaskId((id) => id ?? t[0]?.id ?? null);
        })
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const center =
    view === "fleet" ? (
      <MachineList machines={machines} />
    ) : view === "jobs" ? (
      <AgentJobTable
        tasks={tasks}
        projects={projects}
        machines={machines}
        selectedId={selectedTaskId}
        onSelect={setSelectedTaskId}
      />
    ) : view === "projects" ? (
      <ProjectRegistry projects={projects} machines={machines} tasks={tasks} />
    ) : view === "browser" ? (
      <BrowserView />
    ) : (
      <SettingsView />
    );

  return (
    <AppShell
      topbar={<Topbar view={view} backend={backend} />}
      sidebar={
        <Sidebar
          view={view}
          onNavigate={setView}
          machines={machines}
          projects={projects}
        />
      }
      center={center}
      detail={
        <AgentJobDetail
          task={selectedTask}
          project={projects.find((p) => p.id === selectedTask?.projectId)}
          machine={machines.find((m) => m.id === selectedTask?.machineId)}
        />
      }
      logs={<BottomDock task={selectedTask} />}
    />
  );
}
