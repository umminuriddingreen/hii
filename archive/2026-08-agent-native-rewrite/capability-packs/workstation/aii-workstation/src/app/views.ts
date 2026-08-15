export type View = "fleet" | "jobs" | "projects" | "browser" | "settings";

export const viewLabels: Record<View, string> = {
  fleet: "Fleet Dashboard",
  jobs: "Agent Jobs",
  projects: "Project Registry",
  browser: "Helium Browser",
  settings: "Settings",
};
