//! CLI-owned personal library. Content operations never register or execute skills.
use crate::config::AppPaths;
use clap::Subcommand;
use hii_core::library;
use serde_json::{json,Value};
use std::{fs,io::{self,Read},path::PathBuf};

#[derive(Subcommand,Debug)]
pub enum LibraryCommand {
    Inventory,
    List { #[arg(default_value="")] query:String, #[arg(long)] archived:bool },
    Show { id:String, #[arg(long)] version:Option<String> },
    Import { source:PathBuf, #[arg(long,default_value="skill")] kind:String, #[arg(long,default_value="global")] scope:String },
    Edit { id:String, source:PathBuf, #[arg(long)] expected:String },
    Export { id:String, output:PathBuf },
    Archive { id:String, #[arg(long)] expected:String },
    Restore { id:String, #[arg(long)] expected:String },
    Doctor,
    Sync { #[arg(long)] initialize_key:bool },
    KeyExport { output:PathBuf },
    /// Structured adapter for the canvas, desktop and local automation.
    Request,
}

pub fn inventory(paths:&AppPaths)->Value {
    let mut roots=Vec::new();
    if let Some(home)=dirs::home_dir(){
       for relative in [".codex/skills",".agents/skills",".claude/skills",".claude/prompts",".codex/prompts",".claude/CLAUDE.md",".codex/AGENTS.md"]{
           roots.push((home.join(relative),"global".into(),"local-agent".into()));
       }
       roots.push((home.join(".codex/plugins/cache"),"global".into(),"vendor".into()));
       roots.push((home.join(".claude/plugins/cache"),"global".into(),"vendor".into()));
    }
    roots.push((paths.runtime.join("skills/registered"),"global".into(),"hii-authored".into()));
    roots.push((paths.runtime.join("skills/proposed"),"global".into(),"hii-draft".into()));
    roots.push((paths.repo.join("skills"),format!("project:{}",paths.repo.display()),"project".into()));
    roots.push((paths.repo.join("AGENTS.md"),format!("project:{}",paths.repo.display()),"project".into()));
    json!({"items":library::inventory(&roots),"readOnly":true})
}

pub fn request(paths:&AppPaths,value:&Value,read_only:bool)->Result<Value,String>{
    let op=value["op"].as_str().ok_or("Missing library operation")?;
    let field=|name:&str|value[name].as_str().ok_or_else(||format!("Missing {name}"));
    if read_only&&!["list","show","inventory","doctor","bundle"].contains(&op){return Err("Read-only library access".into());}
    match op {
       "list"=>Ok(json!({"items":library::list(&paths.runtime,value["query"].as_str().unwrap_or(""),value["archived"].as_bool().unwrap_or(false))?})),
       "show"=>library::read(&paths.runtime,field("id")?,value["version"].as_str()),
       "bundle"=>{
           use base64::Engine;
           let mut bundle=library::bundle(&paths.runtime,field("id")?)?;
           for file in bundle["files"].as_array_mut().ok_or("Missing files")? {
               let bytes:Vec<u8>=serde_json::from_value(file["bytes"].take()).map_err(|_|"Invalid stored bytes")?;
               file.as_object_mut().unwrap().remove("bytes");file["base64"]=json!(base64::engine::general_purpose::STANDARD.encode(bytes));
           }Ok(bundle)
       },
       "inventory"=>Ok(inventory(paths)),
       "doctor"=>library::doctor(&paths.runtime),
       "save"=>{
           let files=value["files"].as_array().ok_or("Missing bundle files")?;
           if files.len()>512{return Err("Too many bundle files".into());}
           let mut data=Vec::new();
           for f in files {let name=f["path"].as_str().ok_or("Missing file path")?.to_owned();
               let bytes=if let Some(text)=f["text"].as_str(){text.as_bytes().to_vec()}else if let Some(encoded)=f["base64"].as_str(){use base64::Engine;base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|"Invalid base64 file")?}else{serde_json::from_value::<Vec<u8>>(f["bytes"].clone()).map_err(|_|"Invalid file bytes")?};
               data.push((name,bytes));
           }
           let update=match value["id"].as_str(){Some(id)=>Some((id,field("expected")?)),None=>None};
           let entry=library::import_bytes(&paths.runtime,field("name")?,field("kind")?,field("scope")?,data,None,update)?;
           if let Some(source)=value["sourcePath"].as_str(){library::record_source(&paths.runtime,&entry.id,source,value["sourceDevice"].as_str().unwrap_or("provided-source"))?;}
           Ok(json!({"entry":entry}))
       },
       "archive"|"restore"=>Ok(json!({"entry":library::archive(&paths.runtime,field("id")?,op=="archive",field("expected")?)?})),
       _=>Err("Unsupported library operation".into()),
    }
}
pub fn execute(paths:&AppPaths,command:LibraryCommand)->Result<(),String>{
    let out=match command {
        LibraryCommand::Inventory=>inventory(paths),
        LibraryCommand::List{query,archived}=>json!({"items":library::list(&paths.runtime,&query,archived)?}),
        LibraryCommand::Show{id,version}=>library::read(&paths.runtime,&id,version.as_deref())?,
        LibraryCommand::Import{source,kind,scope}=>{
            let entry=library::import_path(&paths.runtime,&source,&kind,&scope,None)?;
            let receipt=json!({"id":uuid::Uuid::new_v4().to_string(),"operation":"library.import","source":fs::canonicalize(&source).map_err(|e|e.to_string())?,"destination":format!("hii://library/{}",entry.id),"head":entry.head,"originalPreserved":true,"rollback":"archive imported item; original source remains unchanged","entry":entry});
            let path=paths.runtime.join("reports/library").join(format!("{}.json",receipt["id"].as_str().unwrap()));crate::store::write_json_atomic(&path,&receipt)?;
            json!({"entry":receipt["entry"],"receiptPath":path})
        },
        LibraryCommand::Edit{id,source,expected}=>{
            let detail=library::read(&paths.runtime,&id,None)?;let kind=detail["entry"]["kind"].as_str().unwrap();let scope=detail["entry"]["scope"].as_str().unwrap();
            json!({"entry":library::import_path(&paths.runtime,&source,kind,scope,Some((&id,&expected)))?})
        },
        LibraryCommand::Export{id,output}=>json!({"output":library::export(&paths.runtime,&id,&output)?}),
        LibraryCommand::Archive{id,expected}=>json!({"entry":library::archive(&paths.runtime,&id,true,&expected)?}),
        LibraryCommand::Restore{id,expected}=>json!({"entry":library::archive(&paths.runtime,&id,false,&expected)?}),
        LibraryCommand::Doctor=>library::doctor(&paths.runtime)?,
        LibraryCommand::Sync{initialize_key}=>crate::library_sync::sync(paths,initialize_key)?,
        LibraryCommand::KeyExport{output}=>crate::library_sync::export_key(paths,&output)?,
        LibraryCommand::Request=>{let mut raw=String::new();io::stdin().take(32*1024*1024+1).read_to_string(&mut raw).map_err(|e|e.to_string())?;if raw.len()>32*1024*1024{return Err("Library request exceeds limit".into());}request(paths,&serde_json::from_str::<Value>(&raw).map_err(|e|e.to_string())?,false)?},
    };
    println!("{}",serde_json::to_string_pretty(&out).map_err(|e|e.to_string())?);Ok(())
}
