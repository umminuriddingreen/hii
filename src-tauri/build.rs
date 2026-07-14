fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let portable_resources = std::path::Path::new(&manifest_dir).join("..").join(".hii-app");
    std::fs::create_dir_all(portable_resources).expect("create HII portable resource directory");
    tauri_build::build()
}
