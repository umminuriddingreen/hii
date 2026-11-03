//! One bounded adapter for human-facing projections over the existing runtime.
use crate::config::AppPaths;
use serde_json::{json,Value};
use std::io::{self,Read};
pub fn request(paths:&AppPaths,value:Value)->Result<Value,String>{
    match value["op"].as_str().ok_or("Missing surface operation")? {
        "snapshot"=>serde_json::to_value(hii_core::runtime_space_snapshot(value["spaceId"].as_str().map(str::to_owned))?).map_err(|e|e.to_string()),
        "apply"=>serde_json::to_value(hii_core::runtime_space_apply(serde_json::from_value(value["request"].clone()).map_err(|e|e.to_string())?)?).map_err(|e|e.to_string()),
        "catalog"=>Ok(json!({"applications":crate::applications::list(paths)?,"resources":crate::ecosystem_catalog::build(&paths.runtime),"library":hii_core::library::doctor(&paths.runtime)?})),
        "health"=>Ok(json!({"runtimeRoot":paths.runtime,"sourceRoot":paths.repo,"version":env!("CARGO_PKG_VERSION"),"authority":"hii-rust-runtime","library":hii_core::library::doctor(&paths.runtime)?})),
        _=>Err("Unsupported surface operation".into()),
    }
}
pub fn execute(paths:&AppPaths)->Result<(),String>{
    let mut bytes=Vec::new();io::stdin().take(32*1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len()>32*1024*1024{return Err("Surface request exceeds limit".into());}
    let out=request(paths,serde_json::from_slice(&bytes).map_err(|e|e.to_string())?)?;
    println!("{}",serde_json::to_string(&out).map_err(|e|e.to_string())?);Ok(())
}
