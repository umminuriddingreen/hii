'use client';
import { useEffect, useState } from 'react';

export function CanvasThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setDark(root.dataset.theme === 'dark' || (!root.dataset.theme && media.matches));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('change', sync);
    sync();
    return () => { observer.disconnect(); media.removeEventListener('change', sync); };
  }, []);
  const toggle = () => {
    const theme = dark ? 'light' : 'dark';
    try { window.localStorage.setItem('hii.theme.v1', theme); } catch {}
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    setDark(!dark);
  };
  return <button type="button" data-workspace-ui aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`}
    onClick={toggle} style={{ position: 'absolute', bottom: 18, left: 20, zIndex: 110, padding: '8px 14px', borderRadius: 12, background: 'var(--panel, #fff)', color: 'var(--ink, #222)', border: '1px solid var(--line, #ccc)', fontSize: 13 }}>
    {dark ? 'Light mode' : 'Dark mode'}
  </button>;
}
