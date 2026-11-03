//! Account-scoped opaque ciphertext transport. This service never receives library keys.
use crate::{api_error,json_response,now_ms};
use serde::Deserialize;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use worker::{D1Database,Env,Method,Request,Response,Result};
const CHUNK:usize=1024*1024;
pub fn is_path(path:&str)->bool{path.starts_with("/api/device/library/")||path.starts_with("/api/library/")}
fn hash_id(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase())}
fn sha256(bytes:&[u8])->String{Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect()}
fn valid_manifest(value:&Value)->bool{
    value.as_object().is_some_and(|o|o.len()==3)&&value["version"]==1&&value["sha256"].as_str().is_some_and(hash_id)&&
    value["chunks"].as_array().is_some_and(|a|!a.is_empty()&&a.len()<=256&&a.iter().all(|h|h.as_str().is_some_and(hash_id)))
}
#[derive(Deserialize)] struct IndexRow {revision:i64,manifest_json:String}
#[derive(Deserialize)] struct HashRow {hash:String}
#[derive(Deserialize)] struct CountRow {count:usize}
const GC_CANDIDATES:&str="SELECT c.hash FROM account_library_chunks c LEFT JOIN account_library l ON l.account_id=c.account_id WHERE c.account_id=?1 AND c.hash NOT IN (SELECT value FROM json_each(COALESCE(l.manifest_json,'{}'),'$.chunks')) AND c.hash NOT IN (SELECT value FROM json_each(COALESCE(l.previous_manifest_json,'{}'),'$.chunks')) AND c.uploaded_at<?2 LIMIT 8";
async fn collect_expired(env:&Env,db:&D1Database,account:&str)->Result<()>{
    let rows=db.prepare(GC_CANDIDATES).bind(&[account.into(),((now_ms()-60*60*1000) as f64).into()])?.all().await?.results::<HashRow>()?;
    let bucket=env.bucket("DOWNLOADS")?;
    for row in rows {
        let marked=db.prepare("UPDATE account_library_chunks SET gc_pending=1,ready=0 WHERE account_id=?1 AND hash=?2 AND uploaded_at<?3 AND hash NOT IN (SELECT value FROM account_library,json_each(manifest_json,'$.chunks') WHERE account_id=?1) AND hash NOT IN (SELECT value FROM account_library,json_each(COALESCE(previous_manifest_json,'{}'),'$.chunks') WHERE account_id=?1)").bind(&[account.into(),row.hash.as_str().into(),((now_ms()-60*60*1000) as f64).into()])?.run().await?.meta()?.and_then(|m|m.changes)==Some(1);
        if !marked{continue;}
        bucket.delete(format!("private-library/{account}/{}",row.hash)).await?;
        db.prepare("DELETE FROM account_library_chunks WHERE account_id=?1 AND hash=?2 AND gc_pending=1").bind(&[account.into(),row.hash.into()])?.run().await?;
    }Ok(())
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)] struct Commit {expected_revision:i64,manifest:Value}
pub async fn handle(request:&mut Request,env:&Env,db:&D1Database,account:&str)->Result<Response>{
    let path=request.url()?.path().to_owned();let tail=path.split("/library/").nth(1).unwrap_or("");
    if tail=="index"&&request.method()==Method::Get{
        let row=db.prepare("SELECT revision,manifest_json FROM account_library WHERE account_id=?1").bind(&[account.into()])?.first::<IndexRow>(None).await?;
        return json_response(200,match row{Some(r)=>json!({"accountId":account,"revision":r.revision,"manifest":serde_json::from_str::<Value>(&r.manifest_json)?}),None=>json!({"accountId":account,"revision":0,"manifest":null})});
    }
    if tail=="index"&&request.method()==Method::Post{
        let bytes=request.bytes().await?;if bytes.len()>32*1024{return api_error(413,"manifest_too_large");}
        let input:Commit=match serde_json::from_slice(&bytes){Ok(v)=>v,Err(_)=>return api_error(400,"invalid_library_commit")};
        if input.expected_revision<0||!valid_manifest(&input.manifest){return api_error(400,"invalid_library_manifest");}
        let chunks=input.manifest["chunks"].to_string();
        let expected=input.manifest["chunks"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<std::collections::BTreeSet<_>>().len();
        let count=db.prepare("SELECT COUNT(*) AS count FROM account_library_chunks WHERE account_id=?1 AND ready=1 AND hash IN (SELECT value FROM json_each(?2))").bind(&[account.into(),chunks.as_str().into()])?.first::<CountRow>(None).await?;
        if count.map(|r|r.count)!=Some(expected){return api_error(409,"library_chunk_missing");}
        let revision=input.expected_revision+1;
        let changed=if input.expected_revision==0 {
            db.prepare("INSERT OR IGNORE INTO account_library(account_id,revision,manifest_json,updated_at) SELECT ?1,1,?2,?3 WHERE (SELECT COUNT(*) FROM account_library_chunks WHERE account_id=?1 AND ready=1 AND gc_pending=0 AND hash IN (SELECT value FROM json_each(?4)))=?5").bind(&[account.into(),input.manifest.to_string().into(),(now_ms() as f64).into(),chunks.as_str().into(),(expected as f64).into()])?.run().await?
        } else {
            db.prepare("UPDATE account_library SET revision=?1,previous_manifest_json=manifest_json,manifest_json=?2,updated_at=?3 WHERE account_id=?4 AND revision=?5 AND (SELECT COUNT(*) FROM account_library_chunks WHERE account_id=?4 AND ready=1 AND gc_pending=0 AND hash IN (SELECT value FROM json_each(?6)))=?7").bind(&[(revision as f64).into(),input.manifest.to_string().into(),(now_ms() as f64).into(),account.into(),(input.expected_revision as f64).into(),chunks.as_str().into(),(expected as f64).into()])?.run().await?
        }.meta()?.and_then(|m|m.changes)==Some(1);
        if !changed{return api_error(409,"library_revision_conflict");}
        db.prepare("UPDATE account_library_chunks SET committed_revision=?1 WHERE account_id=?2 AND hash IN (SELECT value FROM json_each(?3))").bind(&[(revision as f64).into(),account.into(),chunks.into()])?.run().await?;
        collect_expired(env,db,account).await?;
        return json_response(200,json!({"revision":revision}));
    }
    let Some(hash)=tail.strip_prefix("chunks/").filter(|h|hash_id(h)) else{return api_error(404,"not_found")};
    let key=format!("private-library/{account}/{hash}");let bucket=env.bucket("DOWNLOADS")?;
    if request.method()==Method::Get{
        let ready=db.prepare("SELECT hash FROM account_library_chunks WHERE account_id=?1 AND hash=?2 AND ready=1").bind(&[account.into(),hash.into()])?.first::<Value>(None).await?;
        if ready.is_none(){return api_error(404,"not_found");}
        let Some(object)=bucket.get(&key).execute().await? else{return api_error(404,"not_found")};
        let Some(body)=object.body() else{return api_error(404,"not_found")};
        let bytes=body.bytes().await?;
        if bytes.len()>CHUNK||sha256(&bytes)!=hash{return api_error(500,"library_integrity_failure");}
        return Response::from_bytes(bytes);
    }
    if request.method()==Method::Put{
        if request.headers().get("content-length")?.and_then(|s|s.parse::<usize>().ok()).is_some_and(|n|n>CHUNK){return api_error(413,"chunk_too_large");}
        let bytes=request.bytes().await?;
        if bytes.is_empty()||bytes.len()>CHUNK||sha256(&bytes)!=hash{return api_error(400,"invalid_encrypted_chunk");}
        // Reserve a bounded account quota before storing bytes. Failed uploads can retry the same reservation.
        collect_expired(env,db,account).await?;
        db.prepare("INSERT OR IGNORE INTO account_library_chunks(account_id,hash,size,ready,uploaded_at) SELECT ?1,?2,?3,0,?4 WHERE (SELECT COALESCE(SUM(size),0) FROM account_library_chunks WHERE account_id=?1)+?3<=1073741824").bind(&[account.into(),hash.into(),(bytes.len() as f64).into(),(now_ms() as f64).into()])?.run().await?;
        let reserved=db.prepare("SELECT hash FROM account_library_chunks WHERE account_id=?1 AND hash=?2 AND gc_pending=0").bind(&[account.into(),hash.into()])?.first::<Value>(None).await?;
        if reserved.is_none(){return api_error(413,"library_account_storage_limit");}
        let leased=db.prepare("UPDATE account_library_chunks SET uploaded_at=?1 WHERE account_id=?2 AND hash=?3 AND gc_pending=0").bind(&[(now_ms() as f64).into(),account.into(),hash.into()])?.run().await?.meta()?.and_then(|m|m.changes)==Some(1);
        if !leased{return api_error(409,"library_chunk_retry_required");}
        bucket.put(&key,bytes).execute().await?;
        db.prepare("UPDATE account_library_chunks SET ready=1 WHERE account_id=?1 AND hash=?2").bind(&[account.into(),hash.into()])?.run().await?;
        return json_response(200,json!({"stored":true,"sha256":hash}));
    }api_error(405,"method_not_allowed")
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn only_bounded_ciphertext_manifests_are_accepted(){
        assert!(valid_manifest(&json!({"version":1,"chunks":["a".repeat(64)],"sha256":"b".repeat(64)})));
        assert!(!valid_manifest(&json!({"version":1,"chunks":["../escape"],"sha256":"b".repeat(64)})));
        assert!(!valid_manifest(&json!({"version":1,"chunks":[],"sha256":"b".repeat(64)})));
        assert!(!valid_manifest(&json!({"version":1,"chunks":["a".repeat(64)],"sha256":"b".repeat(64),"key":"secret"})));
    }
}
