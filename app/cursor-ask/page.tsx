// SPDX-License-Identifier: LicenseRef-BSL-1.1
"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function CursorAskPage() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("Ready");
  const [asking, setAsking] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || asking) {
      setStatus(trimmed ? "Working" : "Type a question first");
      return;
    }

    setAsking(true);
    setStatus("Asking Codex");
    setAnswer("");

    try {
      const response = await invoke<string>("cursor_ask", { question: trimmed });
      setAnswer(response);
      setStatus("Ready");
    } catch (error) {
      setAnswer(error instanceof Error ? error.message : String(error));
      setStatus("Codex ask failed");
    } finally {
      setAsking(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      void ask();
    }
    if (event.key === "Escape") {
      void getCurrentWindow().hide();
    }
  }

  return (
    <main className="hii-cursor-ask">
      <form onSubmit={ask} className="hii-cursor-ask__form">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Codex anything"
          aria-label="Ask Codex"
          spellCheck
        />
        <div className="hii-cursor-ask__bar">
          <span>{status}</span>
          <button type="button" onClick={() => void getCurrentWindow().hide()}>
            Hide
          </button>
          <button type="submit" disabled={asking}>
            {asking ? "Asking" : "Ask"}
          </button>
        </div>
      </form>
      <section className="hii-cursor-ask__answer" aria-live="polite">
        {answer || "Ctrl+Enter sends. Escape hides."}
      </section>
    </main>
  );
}
