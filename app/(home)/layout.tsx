import '@xterm/xterm/css/xterm.css';

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden bg-[var(--hii-warm-white)] text-[var(--hii-graphite)]">{children}</div>;
}
