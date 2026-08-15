'use client';

import { useEffect, useRef, useState } from 'react';
import { ambientContext, hideAmbient, listenAmbientOpen, startAgent } from '@/lib/client/hii-bridge';

export function AmbientPrompt() {
  const [value, setValue] = useState('');
  const [context, setContext] = useState<Record<string, unknown>>({});
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const refresh = () => {
      setValue('');
      ambientContext().then(setContext).finally(() => input.current?.focus());
    };
    refresh();
    let dispose = () => {};
    void listenAmbientOpen(refresh).then((unlisten) => { dispose = unlisten; });
    return () => dispose();
  }, []);

  const label = [context.application, context.windowTitle, context.status].filter(Boolean).join(' · ') || 'cursor context · local';

  return (
    <main className="ambient-page">
      <div className="hii-prompt-shell">
        <form className="hii-prompt" onSubmit={async (event) => {
          event.preventDefault();
          if (!value.trim()) return;
          await startAgent({ version: 1, intent: value.trim(), contextNodeIds: [], context });
          setValue('');
          await hideAmbient();
        }}>
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); void hideAmbient(); } }}
            placeholder="What should happen?"
            aria-label="Tell HII what should happen"
            autoComplete="off"
          />
          <div className="hii-prompt-context">{String(label)}</div>
        </form>
      </div>
    </main>
  );
}
