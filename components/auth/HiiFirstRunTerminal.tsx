// SPDX-License-Identifier: LicenseRef-BSL-1.1
'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './HiiFirstRunTerminal.module.css';

export type HiiFirstRunOption = {
  id: string;
  label: string;
  detail: string;
  action: () => void;
  disabled?: boolean;
};

const HII_ASCII = String.raw`
 ██╗  ██╗██╗██╗
 ██║  ██║██║██║
 ███████║██║██║
 ██╔══██║██║██║
 ██║  ██║██║██║
 ╚═╝  ╚═╝╚═╝╚═╝`;

export function HiiFirstRunTerminal({
  options,
  signedInWithChatGPT = false,
  loginOutput = [],
  busy = false,
  onContinue
}: {
  options: HiiFirstRunOption[];
  signedInWithChatGPT?: boolean;
  loginOutput?: string[];
  busy?: boolean;
  onContinue?: () => void;
}) {
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' && enabledOptions.length) {
        event.preventDefault();
        setSelected((value) => (value + 1) % enabledOptions.length);
      } else if (event.key === 'ArrowUp' && enabledOptions.length) {
        event.preventDefault();
        setSelected((value) => (value - 1 + enabledOptions.length) % enabledOptions.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (signedInWithChatGPT) onContinue?.();
        else enabledOptions[selected]?.action();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [enabledOptions, onContinue, selected, signedInWithChatGPT]);

  return <div className={styles.canvas} data-workspace-ui>
    <section className={styles.terminal} aria-label="Welcome to HII" aria-busy={busy || undefined}>
      <pre className={styles.logo} aria-label="HII">{HII_ASCII}</pre>
      <p className={styles.welcome}>Welcome to <strong>HII</strong>, your Human Information Interface</p>

      {signedInWithChatGPT ? <>
        <p className={styles.success}>Signed in with your ChatGPT account</p>
        <div className={styles.before}>
          <p>Before you start:</p>
          <p>HII keeps local files and terminal authority on this computer.</p>
          <small>Connected accounts do not grant source access until you choose what HII may use.</small>
        </div>
        <button className={styles.continue} type="button" onClick={onContinue}>Press enter to continue</button>
      </> : <>
        <p className={styles.question}>How would you like to begin?</p>
        <div className={styles.options} role="listbox" aria-label="HII login options">
          {options.map((option) => {
            const enabledIndex = enabledOptions.findIndex((entry) => entry.id === option.id);
            const active = enabledIndex === selected && !option.disabled;
            return <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={active}
              disabled={option.disabled || busy}
              onMouseEnter={() => { if (enabledIndex >= 0) setSelected(enabledIndex); }}
              onClick={option.action}
            >
              <span><b aria-hidden="true">{active ? '›' : ' '}</b>{option.label}</span>
              <small>{option.detail}</small>
            </button>;
          })}
        </div>
      </>}

      {loginOutput.length ? <pre className={styles.output} aria-live="polite">{loginOutput.slice(-8).join('\n')}</pre> : null}
      {busy ? <p className={styles.busy} role="status">Waiting for sign-in…</p> : null}
    </section>
  </div>;
}
