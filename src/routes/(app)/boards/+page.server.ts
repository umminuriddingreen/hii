import { boardStorePath, boardTaskView, listBoardTasks } from '@/lib/server/hii-board';

export const load = async () => ({
  tasks: (await listBoardTasks({ includeDone: true })).map(boardTaskView),
  store: boardStorePath()
});
