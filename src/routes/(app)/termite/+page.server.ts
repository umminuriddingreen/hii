import { getUser } from '@/lib/supabase/server';
export async function load(){try{return{signedIn:Boolean(await getUser())}}catch{return{signedIn:false}}}
