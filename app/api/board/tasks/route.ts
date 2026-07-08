import { NextResponse } from 'next/server';
import { createBoardTask, listBoardTasks, updateBoardTask } from '@/lib/server/hii-board';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) return NextResponse.json({ error: 'Local access required.' }, { status: 401 });
  const includeDone = new URL(request.url).searchParams.get('includeDone') === '1';
  const tasks = await listBoardTasks({ includeDone });
  return NextResponse.json({ tasks });
}

export async function POST(request: Request) {
  if (!localTerminalAllowed(request)) return NextResponse.json({ error: 'Local access required.' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title : '';
  try {
    const task = await createBoardTask({
      title,
      lane: body?.lane,
      priority: body?.priority,
      owner: body?.owner,
      coordinate: body?.coordinate,
      notes: body?.notes,
      tags: body?.tags,
      source: 'api.board.tasks'
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create task.' }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  if (!localTerminalAllowed(request)) return NextResponse.json({ error: 'Local access required.' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'Task id required.' }, { status: 400 });
  try {
    const task = await updateBoardTask(id, body ?? {});
    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update task.' }, { status: 400 });
  }
}
