import { createClient } from '@/lib/supabase/server';

export async function load() {
  try {
    const supabase=createClient();
    const [{data:{user}},{data:links},{data:orders},{data:downloads}]=await Promise.all([
      supabase.auth.getUser(),
      supabase.from('exchange_links').select('id, price_cents, currency, views, active, asset:assets(title)').order('created_at',{ascending:false}),
      supabase.from('orders').select('exchange_link_id, status, amount_cents, buyer_email, paid_at'),
      supabase.from('download_events').select('asset_id, order_id')
    ]);
    const paid=(orders??[]).filter((row)=>row.status==='paid');
    return {email:user?.email??'',links:links??[],sales:paid.length,downloads:downloads?.length??0,revenue:paid.reduce((sum,row)=>sum+(row.amount_cents??0),0),buyers:Array.from(new Set(paid.map(row=>row.buyer_email).filter(Boolean))),salesByLink:Object.fromEntries((links??[]).map(row=>[row.id,paid.filter(order=>order.exchange_link_id===row.id).length]))};
  } catch { return {email:'',links:[],sales:0,downloads:0,revenue:0,buyers:[],salesByLink:{},warning:'Connect Supabase to load seller analytics.'}; }
}
