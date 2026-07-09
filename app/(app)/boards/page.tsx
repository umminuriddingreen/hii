import Link from 'next/link';
import { BoardClient } from './BoardClient';
import { boardStorePath, listBoardTasks } from '@/lib/server/hii-board';

export const dynamic = 'force-dynamic';

export default async function BoardsPage() {
  const tasks = await listBoardTasks({ includeDone: true });
  const open = tasks.filter((task) => task.lane !== 'done').length;
  const doing = tasks.filter((task) => task.lane === 'doing').length;
  const blocked = tasks.filter((task) => task.lane === 'blocked').length;

  return (
    <div className="hii-page grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
      <aside className="hii-side-nav">
        <Link href="/feed" className="hii-side-link">Feed</Link>
        <Link href="/boards" className="hii-side-link" data-active="true">Boards</Link>
        <Link href="/console" className="hii-side-link">Console</Link>
        <Link href="/credits" className="hii-side-link">Credits</Link>
      </aside>

      <div className="space-y-5">
        <header className="hii-page-header grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <p className="hii-kicker">hii board</p>
            <h1 className="hii-page-title">Tasks as a command surface.</h1>
            <p className="hii-page-copy text-sm">
              Local kanban for agent work, project tracks, and next actions. The browser view is just one shell over the same task log used by the CLI.
            </p>
          </div>
          <div className="hii-card grid grid-cols-3 text-center font-mono text-xs">
            <div className="px-4 py-3">
              <div className="text-lg font-bold">{open}</div>
              <div className="text-neutral-500">open</div>
            </div>
            <div className="border-x border-[rgba(23,107,255,0.24)] px-4 py-3">
              <div className="text-lg font-bold">{doing}</div>
              <div className="text-neutral-500">doing</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-lg font-bold">{blocked}</div>
              <div className="text-neutral-500">blocked</div>
            </div>
          </div>
        </header>

        <div className="hii-terminal-frame grid gap-2 p-3 font-mono text-xs md:grid-cols-3">
          <div>hii board</div>
          <div>hii board move &lt;id&gt; doing</div>
          <div>store {boardStorePath()}</div>
        </div>

        <BoardClient initialTasks={tasks} />
      </div>
    </div>
  );
}
