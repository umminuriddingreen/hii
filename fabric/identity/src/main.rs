use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{io::Read, io::Write};

use hii_fabric_identity::server::{serve, IdentityHttpConfig, IdentityService};
use hii_fabric_identity::store::LedgerStore;
use hii_fabric_identity::{DeviceKeySubmission, IdentityAuthority, IdentityConfig};
use url::Url;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("identity command failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    match args.get(1).map(String::as_str) {
        Some("bootstrap") => bootstrap(&args[2..]),
        Some("recover") => recover(&args[2..]),
        Some("serve") => serve_command(&args[2..]).await,
        _ => Err("usage: hii-fabric-identity <bootstrap|recover|serve> [options]".into()),
    }
}

fn recover(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let store = LedgerStore::new(PathBuf::from(required(args, "--ledger")?))?;
    let origin = Url::parse(required(args, "--origin")?)?;
    let config = IdentityConfig::new(required(args, "--rp-id")?, origin);
    let signing_public_key = hex::decode(required(args, "--signing-key-hex")?)?;
    let encryption_public_key = hex::decode(required(args, "--encryption-key-hex")?)?;
    eprint!("Recovery code (read from local stdin, never logged): ");
    std::io::stderr().flush()?;
    let mut input = String::new();
    std::io::stdin().take(513).read_to_string(&mut input)?;
    let recovery_code = input.trim();
    if recovery_code.is_empty() || recovery_code.len() > 512 {
        return Err("recovery code input is invalid".into());
    }
    let mut authority = store.load_authority(config)?;
    let expected_revision = authority.ledger().revision;
    let outcome = authority.recover(
        recovery_code,
        DeviceKeySubmission {
            device_id: required(args, "--device-id")?.to_owned(),
            display_name: required(args, "--device-name")?.to_owned(),
            signing_public_key,
            encryption_public_key,
        },
        now_ms(),
    )?;
    store.save_if_revision(authority.ledger(), expected_revision)?;
    println!(
        "Identity authority rotated to trust epoch {}",
        outcome.new_trust_epoch
    );
    println!("Replacement passkey registration secret (shown once):");
    println!("{}", outcome.passkey_registration_secret);
    Ok(())
}

fn bootstrap(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let ledger = required(args, "--ledger")?;
    let origin = Url::parse(required(args, "--origin")?)?;
    let config = IdentityConfig::new(required(args, "--rp-id")?, origin);
    let signing_public_key = hex::decode(required(args, "--signing-key-hex")?)?;
    let encryption_public_key = hex::decode(required(args, "--encryption-key-hex")?)?;
    let (authority, material) = IdentityAuthority::bootstrap(
        config,
        required(args, "--account")?,
        required(args, "--owner")?,
        DeviceKeySubmission {
            device_id: required(args, "--device-id")?.to_owned(),
            display_name: required(args, "--device-name")?.to_owned(),
            signing_public_key,
            encryption_public_key,
        },
        optional(args, "--recovery-codes").unwrap_or("8").parse()?,
        now_ms(),
    )?;
    let store = LedgerStore::new(PathBuf::from(ledger))?;
    store.create(authority.ledger())?;
    println!("Identity ledger created at {}", store.path().display());
    println!("Passkey registration secret (shown once):");
    println!("{}", material.passkey_registration_secret);
    println!("Recovery codes (shown once):");
    for code in material.recovery_codes {
        println!("{code}");
    }
    Ok(())
}

async fn serve_command(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let ledger = LedgerStore::new(PathBuf::from(required(args, "--ledger")?))?;
    let origin = Url::parse(required(args, "--origin")?)?;
    let identity = IdentityConfig::new(required(args, "--rp-id")?, origin.clone());
    let port = optional(args, "--port").unwrap_or("8788").parse::<u16>()?;
    let mut http = IdentityHttpConfig::loopback(port, origin);
    if let Some(hosts) = optional(args, "--host") {
        http.allowed_hosts = hosts.split(',').map(str::to_owned).collect();
    }
    let service = Arc::new(IdentityService::open(identity, ledger)?);
    serve(service, http).await?;
    Ok(())
}

fn required<'a>(args: &'a [String], name: &str) -> Result<&'a str, Box<dyn std::error::Error>> {
    optional(args, name).ok_or_else(|| format!("missing required option {name}").into())
}

fn optional<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
