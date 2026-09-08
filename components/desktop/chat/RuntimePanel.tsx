import { useState } from 'react';
import { Check, Play, Stop as Square, X } from '@phosphor-icons/react';
import { chatApi as api } from '@/lib/desktop/chat';
import type { RuntimeStatus, Settings } from '@/lib/desktop/chat-types';

export function RuntimePanel({ settings, status, close, saved, refresh }: {
  settings: Settings; status: RuntimeStatus | null; close: () => void;
  saved: (s: Settings) => void; refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft(d => ({ ...d, [key]: value }));
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onKeyDown={e => { if (e.key === 'Escape') close(); }}>
    <section className="runtime-panel" role="dialog" aria-modal="true" aria-labelledby="runtime-title">
      <header><h2 id="runtime-title">Local runtime</h2><button className="icon" aria-label="Close runtime settings" title="Close" onClick={close}><X size={19} /></button></header>
      <form onSubmit={e => { e.preventDefault(); void action(async () => { await api.saveSettings(draft); saved(draft); }); }}>
        <fieldset disabled={busy || status?.owned}>
          <label>Endpoint<input autoFocus name="endpoint" value={draft.endpoint} onChange={e => update('endpoint', e.target.value)} spellCheck={false} /></label>
          <label>Model<input name="model" list="available-models" value={draft.model} onChange={e => update('model', e.target.value)} spellCheck={false} /></label>
          <datalist id="available-models">{status?.models.map(m => <option key={m.id} value={m.id} />)}</datalist>
          <div className="field-row"><label>Max output<input name="max_tokens" type="number" min="1" max="32768" value={draft.max_tokens} onChange={e => update('max_tokens', e.target.valueAsNumber)} /></label>
            <label>Context size<input name="context_size" type="number" min="512" max="131072" value={draft.context_size} onChange={e => update('context_size', e.target.valueAsNumber)} /></label></div>
          <label className="check"><input name="managed" type="checkbox" checked={draft.managed} onChange={e => update('managed', e.target.checked)} />App-managed llama.cpp</label>
          {draft.managed && <><label>llama-server executable<input name="executable" value={draft.executable} onChange={e => update('executable', e.target.value)} spellCheck={false} /></label>
            <label>GGUF model<input name="model_path" value={draft.model_path} onChange={e => update('model_path', e.target.value)} spellCheck={false} /></label></>}
        </fieldset>
        {error && <p className="error" role="alert">{error}</p>}
        <footer><span className="runtime-state">{status?.state ?? 'Checking'}</span>
          {status?.owned ? <button type="button" disabled={busy} onClick={() => void action(api.stopRuntime)}><Square size={15} />Stop runtime</button> : <>
            <button type="submit" disabled={busy}><Check size={16} />Save</button>
            {draft.managed && <button type="button" disabled={busy} onClick={() => void action(async () => { await api.saveSettings(draft); saved(draft); await api.startRuntime(); })}><Play size={16} />Start runtime</button>}
          </>}
        </footer>
      </form>
    </section>
  </div>;
}
