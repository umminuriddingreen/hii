import { useEffect, useRef, useState } from "react";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../ui/Button";

/**
 * Helium — internal browser pane.
 *
 * A child webview (label "helium") is created once inside the main window and
 * positioned over the placeholder div below. It is hidden — not destroyed —
 * when leaving this view, so navigation state survives view switches.
 */
let helium: Webview | null = null;

const HOME = "https://github.com";

function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return HOME;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.includes(".") && !t.includes(" ")) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

export function BrowserView() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState(HOME);
  const [error, setError] = useState<string | null>(null);

  // Child webview coordinates are relative to the window frame (title bar
  // included), while getBoundingClientRect is relative to the content area —
  // offset by the window chrome height.
  const chromeOffset = async () => {
    const win = getCurrentWindow();
    const [inner, outer, scale] = await Promise.all([
      win.innerSize(),
      win.outerSize(),
      win.scaleFactor(),
    ]);
    return (outer.height - inner.height) / scale;
  };

  const syncBounds = async () => {
    const el = frameRef.current;
    if (!el || !helium) return;
    const r = el.getBoundingClientRect();
    const dy = await chromeOffset();
    helium.setPosition(new LogicalPosition(r.x, r.y + dy)).catch(() => {});
    helium.setSize(new LogicalSize(r.width, r.height)).catch(() => {});
  };

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    (async () => {
      if (!helium) {
        // Survives page reloads: the webview may already exist under its label.
        helium = await Webview.getByLabel("helium");
      }
      if (helium) {
        helium.show().catch(() => {});
        syncBounds();
      } else {
        const r = el.getBoundingClientRect();
        const dy = await chromeOffset();
        const wv = new Webview(getCurrentWindow(), "helium", {
          url: HOME,
          x: r.x,
          y: r.y + dy,
          width: r.width,
          height: r.height,
        });
        helium = wv;
        wv.once("tauri://created", () => syncBounds());
        wv.once("tauri://error", (e) => {
          helium = null;
          setError(`Helium failed to start: ${JSON.stringify(e.payload)}`);
        });
      }
    })();

    const onResize = () => void syncBounds();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      helium?.hide().catch(() => {});
    };
  }, []);

  const go = async (raw?: string) => {
    const url = normalizeUrl(raw ?? input);
    setInput(url);
    setError(null);
    try {
      await invoke("browser_navigate", { url });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-ink-dim">Helium</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          spellCheck={false}
          className="h-7 flex-1 select-text rounded border border-edge bg-panel px-2 font-mono text-[11px] text-ink outline-none focus:border-accent/50"
          placeholder="url or search…"
        />
        <Button onClick={() => go()}>Go</Button>
        <Button variant="ghost" onClick={() => go(HOME)}>
          Home
        </Button>
      </div>
      {error && <div className="text-[11px] text-err">{error}</div>}
      <div
        ref={frameRef}
        className="flex flex-1 items-center justify-center rounded-md border border-edge bg-panel"
      >
        <span className="text-xs text-ink-faint">Starting Helium…</span>
      </div>
    </div>
  );
}
