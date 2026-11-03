import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Task = {
  id: string;
  title: string;
  lane: string;
  owner: string;
  coordinate: string;
};

type HiiHome = {
  generatedAt?: string;
  identity?: { name?: string; role?: string };
  workspace?: { branch?: string; clean?: boolean; changes?: { total?: number } };
  work?: { board?: { open?: number; recent?: Task[] }; activeJobs?: unknown[] };
  nextActions?: Array<{ track?: string; action?: string }>;
};

type ToolResult = { structuredContent?: { home?: HiiHome } };

const readInitialHome = (): HiiHome | undefined => {
  const host = (window as Window & { openai?: { toolOutput?: ToolResult } }).openai;
  return host?.toolOutput?.structuredContent?.home;
};

function App() {
  const [home, setHome] = useState<HiiHome | undefined>(readInitialHome);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const message = event.data as { method?: string; params?: ToolResult };
      if (message?.method !== "ui/notifications/tool-result") return;
      const next = message.params?.structuredContent?.home;
      if (next) setHome(next);
    };
    window.addEventListener("message", onMessage, { passive: true });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!home) {
    return <main className="shell"><p className="eyebrow">HII</p><h1>Waiting for local context…</h1></main>;
  }

  const recent = home.work?.board?.recent?.slice(0, 4) ?? [];
  const changes = home.workspace?.changes?.total ?? 0;

  return (
    <main className="shell">
      <header>
        <div><p className="eyebrow">LOCAL CONTROL PLANE</p><h1>HII Home</h1></div>
        <span className={home.workspace?.clean ? "signal clean" : "signal working"}>
          {home.workspace?.clean ? "clean" : `${changes} changes`}
        </span>
      </header>

      <p className="role">{home.identity?.role}</p>

      <section className="metrics" aria-label="Workspace summary">
        <article><span>branch</span><strong>{home.workspace?.branch ?? "unknown"}</strong></article>
        <article><span>open work</span><strong>{home.work?.board?.open ?? 0}</strong></article>
        <article><span>active jobs</span><strong>{home.work?.activeJobs?.length ?? 0}</strong></article>
      </section>

      <section className="work">
        <div className="section-title"><h2>Current coordinates</h2><span>read-only</span></div>
        {recent.length === 0 ? <p className="empty">No bounded work is currently visible.</p> : recent.map((task) => (
          <article className="task" key={task.id}>
            <div><span className="lane">{task.lane}</span><h3>{task.title}</h3></div>
            <p>{task.owner} · {task.coordinate}</p>
          </article>
        ))}
      </section>

      {home.nextActions?.[0] && <footer><span>Next</span><p>{home.nextActions[0].action}</p></footer>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
