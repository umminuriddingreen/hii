import type { NodeSeed } from './ingest';
export type ContactSheetItem = { url:string; path:string; name:string; mime:string; size:number; sha256:string };
export type ContactSheetSelection = ContactSheetItem & { label?:string };
const text=(value:unknown,max=1000)=>String(value??'').replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max);

export function normalizeContactSheetItems(value:unknown):ContactSheetItem[]{
  if(!Array.isArray(value))return[];
  return value.map(raw=>{const item=raw&&typeof raw==='object'?raw as Record<string,unknown>:{},sha256=text(item.sha256,128);return{
    url:text(item.url),path:text(item.path),name:text(item.name,240)||'image',mime:text(item.mime,120),
    size:Math.max(0,Number(item.size)||0),sha256:/^[a-f0-9]{64}$/i.test(sha256)?sha256.toLowerCase():''
  }}).filter(item=>item.path&&item.sha256).slice(0,80);
}

export function normalizeContactSheetSelection(itemsValue:unknown,selectedValue:unknown):ContactSheetSelection[]{
  const items=normalizeContactSheetItems(itemsValue),selected=Array.isArray(selectedValue)?selectedValue:[];
  const labels=new Map(selected.map(raw=>{const item=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};return[text(item.sha256,128),text(item.label,160)]}));
  return items.filter(item=>labels.has(item.sha256)).slice(0,12).map(item=>({...item,...(labels.get(item.sha256)?{label:labels.get(item.sha256)}:{})}));
}

export function contactSheetContextItems(input:{nodeId:string;items:unknown;selectedItems:unknown;proofRefs?:string[]}){
  return normalizeContactSheetSelection(input.items,input.selectedItems).map((item,index)=>({
    id:`${input.nodeId}-image-${index+1}`,title:item.label||item.name,type:'image',source:item.path,
    expectedSha256:item.sha256,excerpt:item.label?`Human annotation: ${item.label}`:'',
    objectKind:'asset',owner:'human',proofRefs:Array.from(new Set([...(input.proofRefs||[]),`sha256:${item.sha256}`])).slice(0,12)
  }));
}

export function contactSheetItemSeed(itemValue:unknown,parentId:string,label?:string):NodeSeed{
  const item=normalizeContactSheetItems([itemValue])[0];
  if(!item)throw new Error('A durable contact-sheet image is required.');
  const title=text(label,160)||item.name;
  return{
    type:'image',w:520,h:360,
    object:{
      kind:'asset',owner:'human',status:'ready',source:item.path,
      capabilityId:'hii.workspace.creative_canvas',parentId,
      proofRefs:[`sha256:${item.sha256}`],
      audit:[{ts:new Date().toISOString(),actor:'human',action:'promoted contact-sheet image for exact focus',note:title}]
    },
    payload:{
      adapter:'contact-sheet-item',title,name:item.name,url:item.url,path:item.path,mime:item.mime,
      size:item.size,sha256:item.sha256,sourceContactSheetId:parentId
    }
  };
}
