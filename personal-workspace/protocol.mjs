export function allowed(method,path){
 if(typeof path!=="string")return false;
 try{path=decodeURIComponent(path);}catch{return false;}
 if(path.split("/").some(segment=>segment==="."||segment===".."))return false;
 return (method==='GET' && /^\/api\/(workspace|agent-chat\/[A-Za-z0-9_-]+|sessions(?:\/[A-Za-z0-9_.:-]+)?|devices|runs|images\/status|images\/[a-f0-9-]{36}|images\/output\/[a-f0-9-]{36}-\d+\.png|files\/[a-f0-9]{64}(?:\/preview)?)$/.test(path)) ||
 (method==='POST' && /^\/api\/(workspace|chat|agent-chat(?:\/[A-Za-z0-9_-]+\/stop)?|files|images|images\/[a-f0-9-]{36}\/stop|runs|runs\/[a-f0-9-]{36}\/stop)$/.test(path));
}
