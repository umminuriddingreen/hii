// SPDX-License-Identifier: LicenseRef-BSL-1.1
fn main() {
    // The CLI's large command dispatcher exceeds the MSVC default in debug builds.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=hii=/STACK:8388608");
    }
}
