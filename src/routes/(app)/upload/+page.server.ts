import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { r2Configured, uploadObject } from '@/lib/server/r2';
import type { Actions } from './$types';

export const actions: Actions = { default: async ({ request, url }) => {
  const data = await request.formData();
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'You must be signed in to create an exchange.' };
  const title=String(data.get('title')??'').trim(), description=String(data.get('description')??'').trim()||null, price=Number(data.get('price')), licenseName=String(data.get('license_name')??'').trim()||'Standard', exclusivity=String(data.get('exclusivity')??'non-exclusive'), terms=String(data.get('terms')??'').trim(), file=data.get('file');
  if(!title) return {error:'Title is required.'}; if(!Number.isFinite(price)||price<0) return {error:'Invalid price.'}; if(!(file instanceof File)||!file.size) return {error:'A file is required.'}; if(!r2Configured()) return {error:'Storage is not configured.'};
  const assetId=randomUUID(), key=`assets/${assetId}/${file.name}`;
  try { await uploadObject(key,new Uint8Array(await file.arrayBuffer()),file.type||'application/octet-stream'); } catch { return {error:'Upload to storage failed.'}; }
  const {data:license,error:licenseError}=await supabase.from('licenses').insert({seller_id:user.id,name:licenseName,terms,exclusivity}).select('id').single(); if(licenseError)return{error:licenseError.message};
  const {error:assetError}=await supabase.from('assets').insert({id:assetId,seller_id:user.id,title,description,r2_key:key,content_type:file.type||'application/octet-stream',file_size:file.size}); if(assetError)return{error:assetError.message};
  const {data:link,error:linkError}=await supabase.from('exchange_links').insert({seller_id:user.id,asset_id:assetId,license_id:license.id,price_cents:Math.round(price*100)}).select('id').single(); if(linkError)return{error:linkError.message};
  return {linkUrl:`${url.origin}/x/${link.id}`};
}};
