import type { NodeSeed } from './ingest';
export type ContactSheetItem = { url:string; path:string; name:string; mime:string; size:number; sha256:string };
export type ContactSheetSelection = ContactSheetItem & { label?:string };
export type ContactSheetLabels = Record<string,string>;
const text=(value:unknown,max=1000)=>String(value??'').replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max);

export function normalizeContactSheetItems(value:unknown):ContactSheetItem[]{
  if(!Array.isArray(value))return[];
  return value.map(raw=>{const item=raw&&typeof raw==='object'?raw as Record<string,unknown>:{},sha256=text(item.sha256,128);return{
    url:text(item.url),path:text(item.path),name:text(item.name,240)||'image',mime:text(item.mime,120),
    size:Math.max(0,Number(item.size)||0),sha256:/^[a-f0-9]{64}$/i.test(sha256)?sha256.toLowerCase():''
  }}).filter(item=>item.path&&item.sha256).slice(0,80);
}

export function normalizeContactSheetLabels(itemsValue:unknown,labelsValue:unknown):ContactSheetLabels{
  const hashes=new Set(normalizeContactSheetItems(itemsValue).map(item=>item.sha256));
  if(!labelsValue||typeof labelsValue!=='object'||Array.isArray(labelsValue))return{};
  return Object.fromEntries(Object.entries(labelsValue as Record<string,unknown>)
    .map(([sha256,label])=>[text(sha256,128).toLowerCase(),text(label,160)])
    .filter(([sha256,label])=>hashes.has(sha256)&&Boolean(label))
    .slice(0,80));
}

export function normalizeContactSheetSelection(itemsValue:unknown,selectedValue:unknown,labelsValue?:unknown):ContactSheetSelection[]{
  const items=normalizeContactSheetItems(itemsValue),selected=Array.isArray(selectedValue)?selectedValue:[];
  const legacyLabels=new Map(selected.map(raw=>{const item=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};return[text(item.sha256,128).toLowerCase(),text(item.label,160)]}));
  const labels=normalizeContactSheetLabels(items,labelsValue);
  return items.filter(item=>legacyLabels.has(item.sha256)).slice(0,12).map(item=>{
    const label=labels[item.sha256]||legacyLabels.get(item.sha256)||'';
    return{...item,...(label?{label}:{})};
  });
}

export function labelContactSheetItems(input:{items:unknown;labels:unknown;selectedItems:unknown;label:unknown}):ContactSheetLabels{
  const labels=normalizeContactSheetLabels(input.items,input.labels);
  const label=text(input.label,160);
  for(const item of normalizeContactSheetSelection(input.items,input.selectedItems,input.labels)){
    if(label)labels[item.sha256]=label;
    else delete labels[item.sha256];
  }
  return labels;
}

export function filterContactSheetItems(itemsValue:unknown,labelsValue:unknown,queryValue:unknown):ContactSheetItem[]{
  const items=normalizeContactSheetItems(itemsValue),labels=normalizeContactSheetLabels(items,labelsValue);
  const terms=text(queryValue,240).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length)return items;
  return items.filter(item=>{
    const haystack=`${item.name} ${item.path} ${item.mime} ${labels[item.sha256]||''}`.toLocaleLowerCase();
    return terms.every(term=>haystack.includes(term));
  });
}

export function contactSheetContextItems(input:{nodeId:string;items:unknown;selectedItems:unknown;itemLabels?:unknown;proofRefs?:string[]}){
  return normalizeContactSheetSelection(input.items,input.selectedItems,input.itemLabels).map((item,index)=>({
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
