//! Versioned personal library over HII's operational graph and memory blob store.
use serde::{Deserialize, Serialize};
use crate::operational;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::{Read, Write}, path::{Component, Path, PathBuf}};
use uuid::Uuid;

const SPACE: &str = "hii-library:local";
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_BUNDLE: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 512;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub scope: String,
    pub head: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BundleFile { pub path: String, pub hash: String, pub size: u64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Version {
    pub name: String, pub kind: String, pub scope: String,
    pub parent: Option<String>, pub files: Vec<BundleFile>,
}

fn open(runtime: &Path) -> Result<Connection, String> {
    let conn=operational::database(runtime)?; operational::migrate(&conn)?;
    conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e|e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS library_versions (
       item_id TEXT NOT NULL, hash TEXT NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL,
       PRIMARY KEY(item_id,hash));
       CREATE TABLE IF NOT EXISTS library_sources (
       item_id TEXT NOT NULL, source_path TEXT NOT NULL, device TEXT NOT NULL, captured_hash TEXT NOT NULL,
       PRIMARY KEY(item_id,source_path,device));
       CREATE TABLE IF NOT EXISTS library_sync_state (
       account_id TEXT PRIMARY KEY, remote_revision INTEGER NOT NULL, base_json TEXT NOT NULL, status TEXT NOT NULL);")
       .map_err(|e|e.to_string())?;
    let active=fs::read(runtime.join("account/library-context.json")).ok().and_then(|v|serde_json::from_slice::<Value>(&v).ok());
    let device=fs::read(runtime.join("account/device.json")).ok().and_then(|v|serde_json::from_slice::<Value>(&v).ok());
    let namespace=match (active,device){(Some(a),Some(d)) if a["deviceId"]==d["deviceId"]&&a["accountId"].as_str().is_some_and(account_id)=>format!("hii-library:{}",a["accountId"].as_str().unwrap()),_=>SPACE.into()};
    conn.execute_batch("CREATE TEMP TABLE library_context(namespace TEXT NOT NULL)").map_err(|e|e.to_string())?;
    conn.execute("INSERT INTO library_context(namespace) VALUES(?1)",[namespace]).map_err(|e|e.to_string())?;
    conn.execute_batch("BEGIN IMMEDIATE;
      UPDATE operational_objects SET space_id='hii-library:local' WHERE space_id='hii-library';
      UPDATE operational_operations SET lamport=lamport+(SELECT COALESCE(MAX(lamport),0) FROM operational_operations WHERE space_id='hii-library:local'),space_id='hii-library:local' WHERE space_id='hii-library';
      COMMIT;") .map_err(|e|e.to_string())?;
    Ok(conn)
}
fn account_id(id:&str)->bool{id.len()==43&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')}
fn space(conn:&Connection)->Result<String,String>{conn.query_row("SELECT namespace FROM library_context",[],|r|r.get(0)).map_err(|e|e.to_string())}
pub fn activate_account(runtime:&Path,account:&str,device:&str,claim_local:bool)->Result<(),String>{
    if !account_id(account)||!account_id(device){return Err("Invalid library account identity".into());}
    let config:Value=serde_json::from_slice(&fs::read(runtime.join("account/device.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if config["deviceId"]!=device{return Err("Account device changed; reconnect before synchronizing".into());}
    if claim_local {
        let mut conn=open(runtime)?;let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let target=format!("hii-library:{account}");
        let count:i64=tx.query_row("SELECT COUNT(*) FROM operational_objects WHERE space_id=?1",[&target],|r|r.get(0)).map_err(|e|e.to_string())?;
        let local_count:i64=tx.query_row("SELECT COUNT(*) FROM operational_objects WHERE space_id=?1",[SPACE],|r|r.get(0)).map_err(|e|e.to_string())?;
        if count!=0&&local_count!=0{return Err("Account already has local library content; local-only migration requires review".into());}
        tx.execute("UPDATE operational_objects SET space_id=?1 WHERE space_id=?2",params![target,SPACE]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE operational_operations SET space_id=?1 WHERE space_id=?2",params![target,SPACE]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
    }
    let parent=runtime.join("account");fs::create_dir_all(&parent).map_err(|e|e.to_string())?;
    let mut tmp=tempfile::NamedTempFile::new_in(&parent).map_err(|e|e.to_string())?;
    tmp.write_all(json!({"accountId":account,"deviceId":device}).to_string().as_bytes()).map_err(|e|e.to_string())?;
    tmp.as_file().sync_all().map_err(|e|e.to_string())?;
    tmp.persist(parent.join("library-context.json")).map_err(|e|e.to_string())?;Ok(())
}
fn digest(bytes: &[u8]) -> String { blake3::hash(bytes).to_hex().to_string() }
fn valid_hash(hash: &str) -> bool { hash.len()==64 && hash.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase()) }
fn validate_kind_scope(kind: &str,scope: &str) -> Result<(),String> {
    if !["skill","plugin","prompt","instruction","context"].contains(&kind) { return Err("Invalid library kind".into()); }
    if scope!="global" && !(scope.starts_with("project:")&&scope.len()>8&&scope.len()<=512) { return Err("Scope must be global or project:<identity>".into()); }
    Ok(())
}
fn safe_relative(value: &str) -> bool {
    !value.is_empty() && value.len()<=1024 && !value.contains(['\\',':','\0']) &&
    Path::new(value).components().all(|c| matches!(c,Component::Normal(_))) &&
    !value.split('/').any(|s| s.is_empty()||s=="."||s=="..")
}
fn secret_name(path: &Path) -> bool {
    let name=path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    name==".env" || name.starts_with(".env.") || name.contains("credential") || name.contains("private-key") ||
    name.ends_with(".pem") || name.ends_with(".key") || name.starts_with("id_rsa") || name.starts_with("id_ed25519")
}
fn blob_path(runtime:&Path, hash:&str) -> Result<PathBuf,String> {
    if !valid_hash(hash) { return Err("Invalid blob hash".into()); }
    Ok(runtime.join("memory/blobs/blake3").join(&hash[..2]).join(hash))
}
fn blob(runtime:&Path, hash:&str) -> Result<Vec<u8>,String> {
    let path=blob_path(runtime,hash)?;
    if fs::metadata(&path).map_err(|e|e.to_string())?.len()>MAX_FILE { return Err("Blob exceeds limit".into()); }
    let data=fs::read(path).map_err(|e|e.to_string())?;
    if digest(&data)!=hash { return Err(format!("Blob failed integrity check: {hash}")); } Ok(data)
}
fn preserve(runtime:&Path,data:&[u8]) -> Result<String,String> {
    if data.len() as u64>MAX_FILE {return Err("File exceeds 64 MiB".into());}
    let hash=digest(data); let target=blob_path(runtime,&hash)?;
    if target.exists() { blob(runtime,&hash)?; return Ok(hash); }
    fs::create_dir_all(target.parent().unwrap()).map_err(|e|e.to_string())?;
    let mut tmp=tempfile::NamedTempFile::new_in(target.parent().unwrap()).map_err(|e|e.to_string())?;
    tmp.write_all(data).map_err(|e|e.to_string())?; tmp.as_file().sync_all().map_err(|e|e.to_string())?;
    if let Err(error)=tmp.persist_noclobber(&target) {
       if error.error.kind()!=std::io::ErrorKind::AlreadyExists {return Err(error.error.to_string());}
       blob(runtime,&hash)?;
    } Ok(hash)
}
fn collect(source:&Path) -> Result<Vec<(String,Vec<u8>)>,String> {
    let meta=fs::symlink_metadata(source).map_err(|e|e.to_string())?;
    if meta.file_type().is_symlink() || secret_name(source) {return Err("Refusing symlink or credential source".into());}
    let root=if meta.is_dir(){source}else{source.parent().ok_or("Missing source parent")?};
    let mut paths=Vec::new();
    if meta.is_file(){ paths.push(source.to_path_buf()); }
    else if meta.is_dir(){
       for item in walkdir::WalkDir::new(source).follow_links(false).max_depth(16) {
          let item=item.map_err(|e|e.to_string())?;
          if item.file_type().is_symlink() {return Err("Bundle contains a symlink".into());}
          if item.file_type().is_file(){paths.push(item.path().to_path_buf());}
          if paths.len()>MAX_FILES {return Err("Bundle exceeds 512 files".into());}
       }
    } else {return Err("Expected a regular file or bundle".into());}
    paths.sort(); let mut total=0; let mut files=Vec::new();
    for path in paths {
       if secret_name(&path) {return Err(format!("Credential file excluded: {}",path.display()));}
       let relative=path.strip_prefix(root).map_err(|e|e.to_string())?.to_string_lossy().replace('\\',"/");
       if !safe_relative(&relative)||relative.split('/').any(|p|[".git","node_modules",".ssh"].contains(&p)) {return Err("Unsafe bundle member".into());}
       let before=fs::metadata(&path).map_err(|e|e.to_string())?;
       if before.len()>MAX_FILE {return Err("File exceeds 64 MiB".into());}
       let mut bytes=Vec::new(); fs::File::open(&path).map_err(|e|e.to_string())?.take(MAX_FILE+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
       let after=fs::metadata(&path).map_err(|e|e.to_string())?;
       if bytes.len() as u64!=before.len()||before.modified().ok()!=after.modified().ok() {return Err("Source changed during capture".into());}
       total+=bytes.len() as u64; if total>MAX_BUNDLE {return Err("Bundle exceeds 128 MiB".into());}
       files.push((relative,bytes));
    }
    if files.is_empty(){return Err("Empty bundle".into());} Ok(files)
}
fn entries(conn:&Connection)->Result<Vec<Entry>,String>{
    let mut stmt=conn.prepare("SELECT properties_json FROM operational_objects WHERE space_id=?1 ORDER BY id").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([space(conn)?],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?;
    rows.map(|r|serde_json::from_str(&r.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect()
}
fn get_entry(conn:&Connection,id:&str)->Result<Entry,String>{ entries(conn)?.into_iter().find(|e|e.id==id).ok_or("Library item not found".into()) }
fn version(conn:&Connection,id:&str,hash:&str)->Result<Version,String>{
    let raw:String=conn.query_row("SELECT document_json FROM library_versions WHERE item_id=?1 AND hash=?2",params![id,hash],|r|r.get(0)).map_err(|_|"Library version not found".to_string())?;
    if digest(raw.as_bytes())!=hash {return Err("Version failed integrity check".into());}
    serde_json::from_str(&raw).map_err(|e|e.to_string())
}
fn save_entry(conn:&Connection,entry:&Entry,event:&str)->Result<(),String>{
    use rusqlite::OptionalExtension;
    let namespace=space(conn)?;
    let owner:Option<String>=conn.query_row("SELECT space_id FROM operational_objects WHERE id=?1",[&entry.id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if owner.is_some_and(|s|s!=namespace){return Err("Library identity belongs to another account".into());}
    let now=Utc::now().to_rfc3339(); let data=serde_json::to_string(entry).map_err(|e|e.to_string())?;
    conn.execute("INSERT INTO operational_objects(id,space_id,type,properties_json,created_at,updated_at,canonical_source,provenance_class)
       VALUES(?1,?2,'library-item',?3,?4,?4,'graph','human_authored') ON CONFLICT(id) DO UPDATE SET
       properties_json=excluded.properties_json,updated_at=excluded.updated_at,semantic_version=semantic_version+1",params![entry.id,namespace,data,now]).map_err(|e|e.to_string())?;
    conn.execute("INSERT INTO operational_operations(id,space_id,actor_id,type,target_id,lamport,payload_json,created_at,authority_json)
       VALUES(?1,?2,'human:local',?3,?4,(SELECT COALESCE(MAX(lamport),0)+1 FROM operational_operations WHERE space_id=?2),?5,?6,'{\"authority\":\"library-content\"}')",
       params![Uuid::now_v7().to_string(),namespace,event,entry.id,data,now]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn import_path(runtime:&Path, source:&Path, kind:&str, scope:&str, update:Option<(&str,&str)>)->Result<Entry,String>{
    validate_kind_scope(kind,scope)?;
    let data=collect(source)?;
    let name=source.file_name().unwrap_or_default().to_string_lossy().into_owned();
    import_bytes(runtime,&name,kind,scope,data,Some(source),update)
}
/// Used by canvas paste: bytes are saved as content, never evaluated or installed.
pub fn import_bytes(runtime:&Path,name:&str,kind:&str,scope:&str,data:Vec<(String,Vec<u8>)>,source:Option<&Path>,update:Option<(&str,&str)>)->Result<Entry,String>{
    validate_kind_scope(kind,scope)?;
    if name.trim().is_empty()||name.len()>256||data.is_empty()||data.len()>MAX_FILES {return Err("Invalid bundle".into());}
    let mut files=Vec::new(); let mut seen=std::collections::BTreeSet::new(); let mut size=0;
    for (path,bytes) in data {
        if !safe_relative(&path)||secret_name(Path::new(&path))||!seen.insert(path.clone()){return Err("Invalid or duplicate bundle path".into());}
        if serde_json::from_slice::<Value>(&bytes).ok().is_some_and(|v| (v["key"].as_array().is_some_and(|k|k.len()==32)&&v["accountId"].is_string())||(v["token"].is_string()&&v["deviceId"].is_string())) {return Err("Credential material must remain device-local".into());}
        size+=bytes.len() as u64; if size>MAX_BUNDLE{return Err("Bundle exceeds 128 MiB".into());}
        let hash=preserve(runtime,&bytes)?; files.push(BundleFile{path,hash,size:bytes.len() as u64});
    }
    files.sort_by(|a,b|a.path.cmp(&b.path));
    let mut conn=open(runtime)?; let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let mut parent=None; let mut existing=None;
    if let Some((id,expected))=update {
       let entry=get_entry(&tx,id)?;
       if entry.head!=expected {return Err("Library version conflict; both versions are preserved".into());}
       if entry.kind!=kind||entry.scope!=scope{return Err("Editing cannot change kind or instruction scope".into());}
       parent=Some(entry.head.clone()); existing=Some(entry);
    } else {
       // Names and source paths are provenance, not duplicate identity.
       for entry in entries(&tx)? {
           if entry.kind==kind&&entry.scope==scope {
               let v=version(&tx,&entry.id,&entry.head)?;
               if serde_json::to_value(&v.files).unwrap()==serde_json::to_value(&files).unwrap(){existing=Some(entry);break;}
           }
       }
    }
    let entry=if let Some(entry)=existing.filter(|_|update.is_none()) {entry} else {
       let id=update.map(|u|u.0.to_owned()).unwrap_or_else(||Uuid::now_v7().to_string());
       let v=Version{name:name.to_owned(),kind:kind.into(),scope:scope.into(),parent,files};
       let raw=serde_json::to_string(&v).map_err(|e|e.to_string())?; let head=digest(raw.as_bytes());
       tx.execute("INSERT OR IGNORE INTO library_versions(item_id,hash,document_json,created_at) VALUES(?1,?2,?3,?4)",params![id,head,raw,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
       let entry=Entry{id,name:name.to_owned(),kind:kind.into(),scope:scope.into(),head,archived:false};
       save_entry(&tx,&entry,"library.version.saved")?; entry
    };
    if let Some(source)=source {
       let source=fs::canonicalize(source).map_err(|e|e.to_string())?;
       let device=std::env::var("COMPUTERNAME").or_else(|_|std::env::var("HOSTNAME")).unwrap_or_else(|_|std::env::consts::OS.into());
       tx.execute("INSERT INTO library_sources(item_id,source_path,device,captured_hash) VALUES(?1,?2,?3,?4)
          ON CONFLICT(item_id,source_path,device) DO UPDATE SET captured_hash=excluded.captured_hash",params![entry.id,source.to_string_lossy(),device,entry.head]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e|e.to_string())?; Ok(entry)
}
pub fn list(runtime:&Path,query:&str,include_archived:bool)->Result<Vec<Entry>,String>{
    let conn=open(runtime)?; let terms:Vec<_>=query.to_lowercase().split_whitespace().map(str::to_owned).collect();
    let mut out=Vec::new();
    for entry in entries(&conn)? {
        if entry.archived&&!include_archived{continue;}
        let mut text=format!("{} {} {}",entry.name,entry.kind,entry.scope).to_lowercase();
        if !terms.is_empty(){for f in version(&conn,&entry.id,&entry.head)?.files {if f.size<=1024*1024 {if let Ok(raw)=String::from_utf8(blob(runtime,&f.hash)?) {text.push_str(&raw.to_lowercase());}}}}
        if terms.iter().all(|t|text.contains(t)){out.push(entry);}
        if out.len()>=1000{break;}
    } Ok(out)
}
pub fn read(runtime:&Path,id:&str,revision:Option<&str>)->Result<Value,String>{
    let conn=open(runtime)?; let entry=get_entry(&conn,id)?; let v=version(&conn,id,revision.unwrap_or(&entry.head))?;
    let mut files=Vec::new();
    for f in &v.files {let bytes=blob(runtime,&f.hash)?; files.push(json!({"path":f.path,"hash":f.hash,"size":f.size,"text":if bytes.len()<=1024*1024 {String::from_utf8(bytes).ok()}else{None}}));}
    let mut stmt=conn.prepare("SELECT source_path,device,captured_hash FROM library_sources WHERE item_id=?1 ORDER BY source_path,device").map_err(|e|e.to_string())?;
    let sources=stmt.query_map([id],|row|Ok(json!({"path":row.get::<_,String>(0)?,"device":row.get::<_,String>(1)?,"hash":row.get::<_,String>(2)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let mut stmt=conn.prepare("SELECT hash,created_at FROM library_versions WHERE item_id=?1 ORDER BY created_at,hash").map_err(|e|e.to_string())?;
    let history=stmt.query_map([id],|r|Ok(json!({"hash":r.get::<_,String>(0)?,"createdAt":r.get::<_,String>(1)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let viewed=revision.unwrap_or(&entry.head).to_owned();
    Ok(json!({"entry":entry,"viewedHash":viewed,"version":v,"files":files,"sources":sources,"history":history,"executable":false}))
}
pub fn bundle(runtime:&Path,id:&str)->Result<Value,String>{
    let detail=read(runtime,id,None)?;let mut files=Vec::new();
    for file in detail["files"].as_array().ok_or("Missing files")?{files.push(json!({"path":file["path"],"bytes":blob(runtime,file["hash"].as_str().ok_or("Missing hash")?)?}));}
    Ok(json!({"version":1,"entry":detail["entry"],"files":files}))
}
/// A transferred source reference is provenance only; it is never opened or executed.
pub fn record_source(runtime:&Path,id:&str,path:&str,device:&str)->Result<(),String>{
    if path.is_empty()||path.len()>4096||device.is_empty()||device.len()>128{return Err("Invalid source reference".into());}
    let conn=open(runtime)?;let entry=get_entry(&conn,id)?;
    conn.execute("INSERT INTO library_sources(item_id,source_path,device,captured_hash) VALUES(?1,?2,?3,?4)
        ON CONFLICT(item_id,source_path,device) DO UPDATE SET captured_hash=excluded.captured_hash",params![id,path,device,entry.head]).map_err(|e|e.to_string())?;Ok(())
}
pub fn archive(runtime:&Path,id:&str,archived:bool,expected:&str)->Result<Entry,String>{
    let mut conn=open(runtime)?; let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let mut entry=get_entry(&tx,id)?; if entry.head!=expected{return Err("Library version conflict".into());}
    entry.archived=archived;save_entry(&tx,&entry,if archived{"library.archived"}else{"library.restored"})?;tx.commit().map_err(|e|e.to_string())?;Ok(entry)
}
pub fn export(runtime:&Path,id:&str,output:&Path)->Result<PathBuf,String>{
    if output.exists(){return Err("Export destination already exists; original preserved".into());}
    let conn=open(runtime)?; let entry=get_entry(&conn,id)?; let v=version(&conn,id,&entry.head)?;
    let mut verified=Vec::new(); for f in v.files{if !safe_relative(&f.path){return Err("Unsafe bundle member".into());}verified.push((f.path,blob(runtime,&f.hash)?));}
    let parent=output.parent().ok_or("Missing export parent")?;fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    let temp=tempfile::tempdir_in(parent).map_err(|e|e.to_string())?;
    for (name,bytes) in verified{let target=temp.path().join(name);fs::create_dir_all(target.parent().unwrap()).map_err(|e|e.to_string())?;let mut file=fs::File::create(target).map_err(|e|e.to_string())?;file.write_all(&bytes).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;}
    // Directory rename is atomic; never replace a nonempty destination.
    if output.exists(){return Err("Export destination appeared during export".into());}
    fs::rename(temp.path(),output).map_err(|e|e.to_string())?;Ok(output.to_path_buf())
}

/// Portable content snapshot. Paths are provenance only and never used as destinations.
pub fn snapshot(runtime:&Path)->Result<Value,String>{
    let conn=open(runtime)?; let items=entries(&conn)?;let mut versions=Vec::new();let mut blobs=BTreeMap::new();
    for item in &items{
        let mut stmt=conn.prepare("SELECT hash,document_json FROM library_versions WHERE item_id=?1 ORDER BY hash").map_err(|e|e.to_string())?;
        for row in stmt.query_map([&item.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?{
            let (hash,raw)=row.map_err(|e|e.to_string())?; let v:Version=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
            for f in &v.files {blobs.entry(f.hash.clone()).or_insert(blob(runtime,&f.hash)?);}
            versions.push(json!({"id":item.id,"hash":hash,"document":raw}));
        }
    }
    let mut stmt=conn.prepare("SELECT s.item_id,s.source_path,s.device,s.captured_hash FROM library_sources s JOIN operational_objects o ON o.id=s.item_id WHERE o.space_id=?1 ORDER BY s.item_id,s.source_path,s.device").map_err(|e|e.to_string())?;
    let sources=stmt.query_map([space(&conn)?],|r|Ok(json!({"id":r.get::<_,String>(0)?,"path":r.get::<_,String>(1)?,"device":r.get::<_,String>(2)?,"hash":r.get::<_,String>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let value=json!({"version":1,"items":items,"versions":versions,"blobs":blobs,"sources":sources});
    if value["items"].as_array().unwrap().len()>1000||serde_json::to_vec(&value).map_err(|e|e.to_string())?.len()>512*1024*1024{return Err("Library exceeds portable snapshot limits; local content preserved".into());}
    Ok(value)
}
pub fn doctor(runtime:&Path)->Result<Value,String>{
    let state=snapshot(runtime)?;
    Ok(json!({"items":state["items"].as_array().unwrap().len(),"versions":state["versions"].as_array().unwrap().len(),"verifiedBlobs":state["blobs"].as_object().unwrap().len(),"store":"hii-operational-graph","executionAuthority":"unchanged"}))
}
pub fn sync_base(runtime:&Path,account:&str)->Result<Value,String>{
    use rusqlite::OptionalExtension;
    let conn=open(runtime)?;
    let raw:Option<String>=conn.query_row("SELECT base_json FROM library_sync_state WHERE account_id=?1",[account],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|v|serde_json::from_str(&v).map_err(|e|e.to_string())).unwrap_or(Ok(json!({"items":[]})))
}
pub fn sync_record(runtime:&Path,account:&str,revision:i64,base:&Value,status:&str)->Result<(),String>{
    open(runtime)?.execute("INSERT INTO library_sync_state(account_id,remote_revision,base_json,status) VALUES(?1,?2,?3,?4)
       ON CONFLICT(account_id) DO UPDATE SET remote_revision=excluded.remote_revision,base_json=excluded.base_json,status=excluded.status",params![account,revision,base.to_string(),status]).map_err(|e|e.to_string())?;Ok(())
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    #[test]
    fn account_switching_never_republishes_another_accounts_items_or_sources(){
        let t=tempfile::tempdir().unwrap();let r=t.path();fs::create_dir(r.join("account")).unwrap();
        let a="a".repeat(43);let b="b".repeat(43);let da="d".repeat(43);let db="e".repeat(43);
        fs::write(r.join("account/device.json"),json!({"deviceId":da}).to_string()).unwrap();
        let item=import_bytes(r,"Private A","prompt","global",vec![("prompt.md".into(),b"Private account A".to_vec())],None,None).unwrap();record_source(r,&item.id,"private/path","pc").unwrap();
        activate_account(r,&a,&da,true).unwrap();let saved=snapshot(r).unwrap();assert_eq!(saved["items"].as_array().unwrap().len(),1);
        fs::write(r.join("account/device.json"),json!({"deviceId":db}).to_string()).unwrap();
        activate_account(r,&b,&db,true).unwrap();let empty=snapshot(r).unwrap();assert!(empty["items"].as_array().unwrap().is_empty());assert!(empty["sources"].as_array().unwrap().is_empty());
        assert!(merge(r,&saved,&json!({"items":[]})).is_err());
        assert!(snapshot(r).unwrap()["items"].as_array().unwrap().is_empty());
        fs::write(r.join("account/device.json"),json!({"deviceId":da}).to_string()).unwrap();activate_account(r,&a,&da,false).unwrap();assert_eq!(snapshot(r).unwrap(),saved);
    }
    #[test]
    fn ciphertext_binds_account_and_detects_tampering() {
        let key=[7u8;32]; let packet=seal(&key,"account-a",b"private prompt").unwrap();
        assert!(!packet.windows(7).any(|b|b==b"private"));
        assert_eq!(unseal(&key,"account-a",&packet).unwrap(),b"private prompt");
        assert!(unseal(&key,"account-b",&packet).is_err());
        assert!(unseal(&[8u8;32],"account-a",&packet).is_err());
        let mut corrupt=packet; *corrupt.last_mut().unwrap()^=1;
        assert!(unseal(&key,"account-a",&corrupt).is_err());
    }
    #[test]
    fn snapshot_roundtrip_contains_attachment_bytes_and_preserves_conflicts() {
        let t=tempfile::tempdir().unwrap(); let a=t.path().join("a");let b=t.path().join("b");
        let entry=import_bytes(&a,"Example","context","global",vec![("note.md".into(),b"First".to_vec()),("image.png".into(),vec![137,80,78,71]),("reference.pdf".into(),b"%PDF-1.4 example".to_vec())],None,None).unwrap();
        let original=snapshot(&a).unwrap(); merge(&b,&original,&json!({"items":[]})).unwrap();
        assert_eq!(snapshot(&b).unwrap(),original);
        import_bytes(&a,"Example","context","global",vec![("note.md".into(),b"PC changed".to_vec())],None,Some((&entry.id,&entry.head))).unwrap();
        import_bytes(&b,"Example","context","global",vec![("note.md".into(),b"Mac changed".to_vec())],None,Some((&entry.id,&entry.head))).unwrap();
        assert!(merge(&b,&snapshot(&a).unwrap(),&original).is_err());
        assert_eq!(read(&b,&entry.id,None).unwrap()["files"][0]["text"],"Mac changed");
    }
    #[test]
    fn archive_propagates_and_unsafe_snapshot_is_atomic() {
        let t=tempfile::tempdir().unwrap();let a=t.path().join("a");let b=t.path().join("b");
        let entry=import_bytes(&a,"Note","prompt","global",vec![("prompt.md".into(),b"Original".to_vec())],None,None).unwrap();
        let base=snapshot(&a).unwrap();merge(&b,&base,&json!({"items":[]})).unwrap();
        archive(&a,&entry.id,true,&entry.head).unwrap();merge(&b,&snapshot(&a).unwrap(),&base).unwrap();
        assert!(list(&b,"",false).unwrap().is_empty());
        let mut bad=base.clone();bad["versions"][0]["document"]=json!("tampered");
        assert!(merge(&b,&bad,&base).is_err());assert!(list(&b,"",false).unwrap().is_empty());
    }
}

pub fn seal(key:&[u8;32],account:&str,data:&[u8])->Result<Vec<u8>,String>{
    use ring::{aead,rand::{SecureRandom,SystemRandom}};
    let mut nonce=[0;12];SystemRandom::new().fill(&mut nonce).map_err(|_|"Randomness unavailable")?;
    let key=aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,key).map_err(|_|"Invalid key")?);
    let mut cipher=zstd::stream::encode_all(data,3).map_err(|e|e.to_string())?;
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(format!("hii-library:v1:{account}")),&mut cipher).map_err(|_|"Encryption failed")?;
    let mut packet=b"HII-LIB1".to_vec();packet.extend(nonce);packet.extend(cipher);Ok(packet)
}
pub fn unseal(key:&[u8;32],account:&str,packet:&[u8])->Result<Vec<u8>,String>{
    use ring::aead;
    if packet.len()<36||packet.len()>256*1024*1024||(&packet[..8]!=b"HII-LIB1"&&&packet[..8]!=b"HII-LIB2") {return Err("Invalid encrypted library packet".into());}
    let nonce:[u8;12]=packet[8..20].try_into().map_err(|_|"Invalid nonce")?;
    let key=aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,key).map_err(|_|"Invalid key")?);
    let mut cipher=packet[20..].to_vec();
    let plain=key.open_in_place(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(format!("hii-library:v1:{account}")),&mut cipher).map_err(|_|"Library key/account mismatch or corrupted ciphertext")?;
    if &packet[..8]==b"HII-LIB2" {if plain.len()>512*1024*1024{return Err("Expanded library exceeds transfer limit".into());}return Ok(plain.to_vec());}
    let decoder=zstd::stream::read::Decoder::new(&*plain).map_err(|e|e.to_string())?;
    let mut result=Vec::new();decoder.take(512*1024*1024+1).read_to_end(&mut result).map_err(|e|e.to_string())?;
    if result.len()>512*1024*1024 {return Err("Expanded library exceeds transfer limit".into());} Ok(result)
}
pub fn merge(runtime:&Path,incoming:&Value,base:&Value)->Result<(),String>{
    if incoming["version"]!=1 {return Err("Unsupported snapshot version".into());}
    let remote:Vec<Entry>=serde_json::from_value(incoming["items"].clone()).map_err(|e|e.to_string())?;
    if remote.len()>1000 {return Err("Snapshot exceeds item limit".into());}
    let blobs:BTreeMap<String,Vec<u8>>=serde_json::from_value(incoming["blobs"].clone()).map_err(|e|e.to_string())?;
    let mut total=0;
    for (hash,bytes) in &blobs {total+=bytes.len();if !valid_hash(hash)||digest(bytes)!=*hash||bytes.len() as u64>MAX_FILE||total>512*1024*1024{return Err("Snapshot blob integrity/size failure".into());}}
    let versions=incoming["versions"].as_array().ok_or("Missing versions")?;
    let mut validated=BTreeMap::new();
    for item in versions {
       let id=item["id"].as_str().ok_or("Missing version identity")?;let hash=item["hash"].as_str().ok_or("Missing version hash")?;
       let raw=item["document"].as_str().ok_or("Missing version document")?;
       if digest(raw.as_bytes())!=hash{return Err("Snapshot version integrity failure".into());}
       let v:Version=serde_json::from_str(raw).map_err(|e|e.to_string())?;validate_kind_scope(&v.kind,&v.scope)?;
       if v.files.is_empty()||v.files.len()>MAX_FILES{return Err("Invalid snapshot bundle".into());}
       let mut names=std::collections::BTreeSet::new();let mut bundle_size=0;
       for f in &v.files {
           if !safe_relative(&f.path)||secret_name(Path::new(&f.path))||!names.insert(&f.path)||blobs.get(&f.hash).map(|b|b.len() as u64)!=Some(f.size){return Err("Invalid snapshot member".into());}
           bundle_size+=f.size;
       }
       if bundle_size>MAX_BUNDLE{return Err("Snapshot bundle exceeds limit".into());}
       if validated.insert((id.to_owned(),hash.to_owned()),raw.to_owned()).is_some(){return Err("Duplicate snapshot version".into());}
    }
    let mut ids=std::collections::BTreeSet::new();
    for entry in &remote{
       if Uuid::parse_str(&entry.id).is_err()||!ids.insert(&entry.id)||entry.name.len()>256{return Err("Invalid snapshot identity".into());}
       let raw=validated.get(&(entry.id.clone(),entry.head.clone())).ok_or("Missing head version")?;
       let v:Version=serde_json::from_str(raw).map_err(|e|e.to_string())?;
       if v.name!=entry.name||v.kind!=entry.kind||v.scope!=entry.scope{return Err("Snapshot metadata mismatch".into());}
    }
    let sources=incoming.get("sources").and_then(Value::as_array).cloned().unwrap_or_default();
    if sources.len()>10000{return Err("Too many source references".into());}
    for s in &sources {
        if !ids.iter().any(|id|s["id"].as_str()==Some(id.as_str()))||s["path"].as_str().is_none_or(|p|p.is_empty()||p.len()>4096)||s["device"].as_str().is_none_or(|p|p.is_empty()||p.len()>128)||!s["hash"].as_str().is_some_and(valid_hash){return Err("Invalid snapshot source reference".into());}
    }
    let ancestors:Vec<Entry>=serde_json::from_value(base.get("items").cloned().unwrap_or(json!([]))).map_err(|e|e.to_string())?;
    let mut conn=open(runtime)?;let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let local=entries(&tx)?;let mut changes=Vec::new();
    for entry in &remote{
       let before=ancestors.iter().find(|e|e.id==entry.id);let current=local.iter().find(|e|e.id==entry.id);
       if current==Some(entry)||before==Some(entry){continue;}
       if current.is_some()&&current!=before{return Err(format!("Library synchronization conflict for {}; both device versions remain intact",entry.id));}
       changes.push(entry);
    }
    for (hash,bytes) in &blobs{let saved=preserve(runtime,bytes)?;if saved!=*hash{return Err("Blob integrity failure".into());}}
    for ((id,hash),raw) in &validated{
       tx.execute("INSERT OR IGNORE INTO library_versions(item_id,hash,document_json,created_at) VALUES(?1,?2,?3,?4)",params![id,hash,raw,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    }
    for entry in changes {save_entry(&tx,entry,"library.sync.received")?;}
    for s in sources {tx.execute("INSERT OR IGNORE INTO library_sources(item_id,source_path,device,captured_hash) VALUES(?1,?2,?3,?4)",params![s["id"].as_str(),s["path"].as_str(),s["device"].as_str(),s["hash"].as_str()]).map_err(|e|e.to_string())?;}
    tx.commit().map_err(|e|e.to_string())?; Ok(())
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct InventoryItem { pub path:PathBuf,pub kind:String,pub scope:String,pub origin:String,pub hash:Option<String>,pub error:Option<String> }

/// Only nominated roots are traversed. Vendor caches are catalogued, never modified.
pub fn inventory(roots:&[(PathBuf,String,String)])->Vec<InventoryItem>{
    let mut result=Vec::new();
    for (root,scope,origin) in roots {
        if !root.exists(){continue;}
        for candidate in walkdir::WalkDir::new(root).follow_links(false).max_depth(10).into_iter().filter_entry(|e| ![".git","node_modules","target",".next","backups","cache"].contains(&e.file_name().to_string_lossy().as_ref())||e.path()==root){
           let Ok(file)=candidate else{continue;};if !file.file_type().is_file(){continue;}
           let name=file.file_name().to_string_lossy();
           let kind=if name=="SKILL.md"{"skill"}else if ["AGENTS.md","CLAUDE.md","PROMPTS.md"].contains(&name.as_ref()){"instruction"}else if name=="plugin.json"{"plugin"}else if name.ends_with(".md")&&root.file_name().is_some_and(|n|n=="prompts"){"prompt"}else{continue;};
           let path=if kind=="skill"{file.path().parent().unwrap().to_path_buf()}else if kind=="plugin"{let parent=file.path().parent().unwrap();if parent.file_name().is_some_and(|n|n==".codex-plugin"||n==".claude-plugin"){parent.parent().unwrap_or(parent).to_path_buf()}else{parent.to_path_buf()}}else{file.path().to_path_buf()};
           let captured=collect(&path).map(|files|digest(&serde_json::to_vec(&files.iter().map(|(p,b)|(p,digest(b))).collect::<Vec<_>>()).unwrap()));
           let (hash,error)=match captured{Ok(h)=>(Some(h),None),Err(e)=>(None,Some(e))};
           result.push(InventoryItem{path,kind:kind.into(),scope:scope.clone(),origin:origin.clone(),hash,error});
           if result.len()>=2000{return result;}
        }
    }result.sort_by(|a,b|a.path.cmp(&b.path));result.dedup_by(|a,b|a.path==b.path&&a.scope==b.scope);result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn exact_bundles_deduplicate_and_export_dependencies_without_changing_sources() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let first = temp.path().join("first"); let second = temp.path().join("second");
        for folder in [&first, &second] {
            fs::create_dir_all(folder.join("scripts")).unwrap();
            fs::write(folder.join("SKILL.md"), "---\nname: personal-example\n---\nRun scripts/task.py").unwrap();
            fs::write(folder.join("scripts/task.py"), "print('example')").unwrap();
        }
        let a = import_path(&runtime, &first, "skill", "global", None).unwrap();
        let b = import_path(&runtime, &second, "skill", "global", None).unwrap();
        assert_eq!(a.id,b.id);
        assert_eq!(read(&runtime,&a.id,None).unwrap()["sources"].as_array().unwrap().len(),2);
        let out = temp.path().join("export"); export(&runtime,&a.id,&out).unwrap();
        assert_eq!(fs::read(out.join("scripts/task.py")).unwrap(),fs::read(first.join("scripts/task.py")).unwrap());
        assert!(export(&runtime,&a.id,&out).is_err());
    }
    #[test]
    fn versions_require_expected_head_and_instruction_scopes_stay_separate() {
        let temp = tempfile::tempdir().unwrap(); let runtime=temp.path().join("runtime");
        let source=temp.path().join("AGENTS.md"); fs::write(&source,"Original").unwrap();
        let a=import_path(&runtime,&source,"instruction","global",None).unwrap();
        let project=import_path(&runtime,&source,"instruction","project:architecture",None).unwrap();
        assert_ne!(a.id,project.id);
        fs::write(&source,"Changed").unwrap();
        let b=import_path(&runtime,&source,"instruction","global",Some((&a.id,&a.head))).unwrap();
        assert_ne!(a.head,b.head);
        assert!(import_path(&runtime,&source,"instruction","global",Some((&a.id,&a.head))).is_err());
        assert_eq!(read(&runtime,&a.id,Some(&a.head)).unwrap()["files"][0]["text"],"Original");
        assert!(archive(&runtime,&a.id,true,&a.head).is_err());
        archive(&runtime,&a.id,true,&b.head).unwrap(); assert_eq!(list(&runtime,"",false).unwrap().len(),1);
        archive(&runtime,&a.id,false,&b.head).unwrap(); assert_eq!(list(&runtime,"",false).unwrap().len(),2);
    }
    #[test]
    fn different_content_is_preserved_as_distinct_items_and_search_reads_content() {
        let temp=tempfile::tempdir().unwrap(); let runtime=temp.path().join("runtime"); let p=temp.path().join("prompt.md");
        fs::write(&p,"Find me an orchard").unwrap(); let a=import_path(&runtime,&p,"prompt","global",None).unwrap();
        fs::write(&p,"Find me a river").unwrap(); let b=import_path(&runtime,&p,"prompt","global",None).unwrap();
        assert_ne!(a.id,b.id); assert_eq!(list(&runtime,"orchard",false).unwrap()[0].id,a.id);
    }
    #[test]
    fn rejects_secret_files_and_corrupted_blobs() {
        let temp=tempfile::tempdir().unwrap(); let runtime=temp.path().join("runtime");
        let secret=temp.path().join(".env"); fs::write(&secret,"PRIVATE=example").unwrap();
        assert!(import_path(&runtime,&secret,"prompt","global",None).is_err());
        let p=temp.path().join("prompt.md"); fs::write(&p,"Sample").unwrap(); let a=import_path(&runtime,&p,"prompt","global",None).unwrap();
        let info=read(&runtime,&a.id,None).unwrap(); let hash=info["files"][0]["hash"].as_str().unwrap();
        fs::write(runtime.join("memory/blobs/blake3").join(&hash[..2]).join(hash),"corrupt").unwrap();
        assert!(export(&runtime,&a.id,&temp.path().join("output")).is_err());
        assert!(!temp.path().join("output").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_dependencies_cannot_escape_bundle() {
        let temp=tempfile::tempdir().unwrap(); let bundle=temp.path().join("bundle"); fs::create_dir(&bundle).unwrap();
        fs::write(bundle.join("SKILL.md"),"Example").unwrap(); fs::write(temp.path().join("outside"),"Private").unwrap();
        std::os::unix::fs::symlink(temp.path().join("outside"),bundle.join("escape")).unwrap();
        assert!(import_path(&temp.path().join("runtime"),&bundle,"skill","global",None).is_err());
    }
}
