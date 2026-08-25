import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const desktop = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const capability = readFileSync(resolve(root, "src-tauri/capabilities/default.json"), "utf8");
const page = readFileSync(resolve(root, "app/cursor-ask/page.tsx"), "utf8");

describe("cursor ask", () => {
  it("registers an OS-level shortcut that opens a cursor-positioned Tauri window", () => {
    expect(cargo).toContain("tauri-plugin-global-shortcut");
    expect(desktop).toContain("CURSOR_ASK_WINDOW");
    expect(desktop).toContain("position_near_cursor");
    expect(desktop).toContain("app.cursor_position()");
    expect(desktop).toContain('register("ctrl+alt+space")');
    expect(desktop).toContain("Modifiers::CONTROL | Modifiers::ALT");
    expect(desktop).toContain("show_cursor_ask(app)");
    expect(capability).toContain('"cursor-ask"');
  });

  it("keeps quick Codex answers read-only and ephemeral", () => {
    expect(desktop).toContain('async fn cursor_ask(question: String)');
    expect(desktop).toContain('"--ephemeral"');
    expect(desktop).toContain('"--skip-git-repo-check"');
    expect(desktop).toContain('"read-only"');
    expect(desktop).toContain('"--output-last-message"');
    expect(page).toContain('invoke<string>("cursor_ask"');
    expect(page).toContain("Ctrl+Enter sends");
  });
});
