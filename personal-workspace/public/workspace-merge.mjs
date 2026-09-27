const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function mergeWorkspace(base,local,remote){
 const maps=[base,local,remote].map(s=>new Map((s.chats||[]).map(c=>[c.id,c]))),out=[],conflicts=[];
 for(const id of new Set([...maps[1].keys(),...maps[2].keys()])){const [b,l,r]=maps.map(m=>m.get(id));if(!l){out.push(r);continue;}if(!r){out.push(l);continue;}const c={};for(const key of new Set([...Object.keys(l),...Object.keys(r)])){if(key==='events'){const all=[...(r.events||[]),...(l.events||[])];c.events=[...new Map(all.map(x=>[JSON.stringify(x),x])).values()];}else if(equal(l[key],r[key])||equal(r[key],b?.[key]))c[key]=l[key];else if(equal(l[key],b?.[key]))c[key]=r[key];else{conflicts.push(id+':'+key);c[key]=l[key];}}out.push(c);}
 return {chats:out,activeId:out.some(c=>c.id===local.activeId)?local.activeId:remote.activeId,conflicts};
}
