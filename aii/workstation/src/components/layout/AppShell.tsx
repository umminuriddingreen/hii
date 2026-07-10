import type { ReactNode } from "react";

/**
 * Fixed control-plane grid:
 *
 * ┌──────────────────────── topbar ────────────────────────┐
 * ├─ sidebar ─┬───── center ─────┬──── detail (right) ─────┤
 * ├───────────┴───── logs (bottom, full width) ────────────┤
 * └─────────────────────────────────────────────────────────┘
 */
export function AppShell({
  topbar,
  sidebar,
  center,
  detail,
  logs,
}: {
  topbar: ReactNode;
  sidebar: ReactNode;
  center: ReactNode;
  detail: ReactNode;
  logs: ReactNode;
}) {
  return (
    <div className="grid h-screen grid-cols-[220px_1fr_340px] grid-rows-[40px_1fr_190px]">
      <div className="col-span-3">{topbar}</div>
      {sidebar}
      <main className="overflow-auto bg-surface p-4">{center}</main>
      <div className="overflow-hidden border-l border-edge bg-panel">{detail}</div>
      <div className="col-span-3 overflow-hidden">{logs}</div>
    </div>
  );
}
