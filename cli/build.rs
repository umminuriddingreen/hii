// SPDX-License-Identifier: LicenseRef-BSL-1.1
fn main() {
    println!("cargo:rerun-if-env-changed=HII_BUILD_COMMIT");

    // The CLI's large command dispatcher exceeds the MSVC default in debug builds.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=hii=/STACK:8388608");
    }

    let explicit = std::env::var("HII_BUILD_COMMIT")
        .ok()
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let discovered = || {
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
        );
        let repo = manifest.parent().unwrap_or(&manifest);
        let output = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    if let Some(commit) = explicit.or_else(discovered).filter(|value| !value.is_empty()) {
        println!("cargo:rustc-env=HII_BUILD_COMMIT={commit}");
    }
}
