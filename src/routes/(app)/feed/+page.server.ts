import { createLinkPost, listLinkPostsWithCache } from '@/lib/server/link-stream';
export const load=async()=>({posts:await listLinkPostsWithCache(80)});
export const actions={default:async({request}:any)=>{await createLinkPost(await request.formData());return{ok:true}}};
