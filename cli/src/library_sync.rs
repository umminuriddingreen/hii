use crate::{config::AppPaths,store};
use hii_core::library;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,io::Read,time::Duration};

const CHUNK:usize=1024*1024;
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase")]
struct KeyFile {version:u8,account_id:String,key:[u8;32]}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn req(method:&str,url:&str,token:&str)->ureq::Request{
    ureq::request(method,url).set("Authorization",&format!("Bearer {token}")).timeout(Duration::from_secs(45))
}
fn remote_error(error:ureq::Error)->String{
    match error {ureq::Error::Status(401,_)=>"HII account device link revoked or expired; local library preserved".into(),ureq::Error::Status(409,_)=>"Account library changed during synchronization; local versions preserved; retry sync".into(),_=>"Account library unavailable; local edits remain queued for the next sync".into()}
}
pub fn export_key(paths:&AppPaths,output:&std::path::Path)->Result<Value,String>{
    use std::io::Write;
    let context:Value=serde_json::from_slice(&fs::read(paths.runtime.join("account/library-context.json")).map_err(|_|"Synchronize this enrolled device before exporting its browser key")?).map_err(|_|"Invalid library account context")?;
    let account=context["accountId"].as_str().ok_or("No selected library account")?;
    if account.len()!=43||!account.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){return Err("Invalid account identity".into());}
    let (_,_,device)=crate::account::library_connection(paths)?;if context["deviceId"]!=device{return Err("Account device changed; synchronize before exporting its key".into());}
    let data=fs::read(paths.runtime.join("account/library-keys").join(format!("{account}.json"))).map_err(|_|"Device-local library key unavailable")?;
    let parent=output.parent().ok_or("Missing output directory")?;fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    let mut temp=tempfile::NamedTempFile::new_in(parent).map_err(|e|e.to_string())?;temp.write_all(&data).map_err(|e|e.to_string())?;temp.as_file().sync_all().map_err(|e|e.to_string())?;
    temp.persist_noclobber(output).map_err(|_|"Key export destination already exists; nothing replaced")?;
    Ok(json!({"output":output,"accountId":account,"containsPrivateKey":true,"purpose":"local browser unlock; never upload this file as library content"}))
}
pub fn sync(paths:&AppPaths,initialize_key:bool)->Result<Value,String>{
    use ring::rand::{SecureRandom,SystemRandom};
    let (api,token,device)=crate::account::library_connection(paths)?;
    let remote:Value=req("GET",&format!("{api}/library/index"),&token).call().map_err(remote_error)?.into_json().map_err(|_|"Invalid account library response")?;
    let account=remote["accountId"].as_str().ok_or("Missing authenticated account identity")?;
    if account.len()!=43||!account.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){return Err("Invalid authenticated account identity".into());}
    let revision=remote["revision"].as_i64().ok_or("Missing remote revision")?;
    let key_path=paths.runtime.join("account/library-keys").join(format!("{account}.json"));
    let key:KeyFile=if key_path.exists(){serde_json::from_slice(&fs::read(&key_path).map_err(|e|e.to_string())?).map_err(|_|"Invalid device-local library key")?}
        else if initialize_key&&revision==0 {let mut key=[0;32];SystemRandom::new().fill(&mut key).map_err(|_|"Randomness unavailable")?;let file=KeyFile{version:1,account_id:account.into(),key};store::write_json_private_atomic(&key_path,&file)?;file}
        else{return Err("This device needs the account's library encryption key from an enrolled device. Initialize only an empty account with --initialize-key.".into());};
    if key.version!=1||key.account_id!=account{return Err("Library key belongs to another account".into());}
    library::activate_account(&paths.runtime,account,&device,initialize_key&&revision==0)?;
    let base=library::sync_base(&paths.runtime,account)?;
    library::sync_record(&paths.runtime,account,revision,&base,"pending")?;
    let mut downloaded=None;
    if !remote["manifest"].is_null(){
        let manifest=&remote["manifest"];let chunks=manifest["chunks"].as_array().ok_or("Missing encrypted chunks")?;
        if chunks.is_empty()||chunks.len()>256{return Err("Invalid encrypted chunk count".into());}
        let mut packet=Vec::new();
        for chunk in chunks {let digest=chunk.as_str().ok_or("Invalid chunk hash")?;
            if digest.len()!=64||!digest.bytes().all(|b|b.is_ascii_hexdigit()){return Err("Invalid chunk hash".into());}
            let mut bytes=Vec::new();req("GET",&format!("{api}/library/chunks/{digest}"),&token).call().map_err(remote_error)?.into_reader().take(CHUNK as u64+1).read_to_end(&mut bytes).map_err(|_|"Chunk read interrupted")?;
            if bytes.len()>CHUNK||hash(&bytes)!=digest{return Err("Encrypted chunk failed verification".into());}packet.extend(bytes);
        }
        if manifest["sha256"].as_str()!=Some(hash(&packet).as_str()){return Err("Encrypted library packet failed verification".into());}
        let incoming:Value=serde_json::from_slice(&library::unseal(&key.key,account,&packet)?).map_err(|_|"Invalid decrypted library")?;
        library::merge(&paths.runtime,&incoming,&base)?;downloaded=Some(incoming);
    }
    let current=library::snapshot(&paths.runtime)?;
    if downloaded.as_ref()==Some(&current){library::sync_record(&paths.runtime,account,revision,&current,"synced")?;return Ok(json!({"status":"synced","revision":revision,"uploaded":false,"encrypted":true}));}
    let packet=library::seal(&key.key,account,&serde_json::to_vec(&current).map_err(|e|e.to_string())?)?;
    if packet.len()>256*CHUNK{return Err("Library exceeds encrypted transfer limit; local content preserved".into());}
    let mut chunks=Vec::new();
    for bytes in packet.chunks(CHUNK){let digest=hash(bytes);req("PUT",&format!("{api}/library/chunks/{digest}"),&token).set("Content-Type","application/octet-stream").send_bytes(bytes).map_err(remote_error)?;chunks.push(digest);}
    let committed:Value=req("POST",&format!("{api}/library/index"),&token).send_json(json!({"expectedRevision":revision,"manifest":{"version":1,"chunks":chunks,"sha256":hash(&packet)}})).map_err(remote_error)?.into_json().map_err(|_|"Invalid account commit response")?;
    let next=committed["revision"].as_i64().ok_or("Account did not acknowledge revision")?;
    library::sync_record(&paths.runtime,account,next,&current,"synced")?;
    Ok(json!({"status":"synced","revision":next,"uploaded":true,"encrypted":true,"items":current["items"].as_array().unwrap().len(),"verifiedBlobs":current["blobs"].as_object().unwrap().len()}))
}
