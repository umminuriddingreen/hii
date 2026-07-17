import { listBoardTasks, boardStorePath } from '@/lib/server/hii-board';
export const load=async()=>({tasks:await listBoardTasks({includeDone:true}),store:boardStorePath()});
