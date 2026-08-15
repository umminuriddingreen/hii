// SPDX-License-Identifier: LicenseRef-BSL-1.1
use std::{
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use axum::{routing::get, Json, Router};
use clap::{Parser, Subcommand};
use mistralrs_core::{AutoDeviceMapParams, ModelDType, ModelSelected};
use mistralrs_server_core::{
    mistralrs_for_server_builder::MistralRsForServerBuilder,
    mistralrs_server_router_builder::MistralRsServerRouterBuilder,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 11435;
const DEFAULT_MODEL: &str = "Qwen/Qwen3-4B";

#[derive(Debug, Parser)]
#[command(
    name = "hii-native-runner",
    about = "HII native mistral.rs model runtime"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve an OpenAI-compatible loopback API.
    Serve {
        #[arg(long, default_value = DEFAULT_MODEL)]
        model: String,
        #[arg(long, default_value = DEFAULT_HOST)]
        host: String,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        #[arg(long, default_value = "4")]
        quant: String,
        #[arg(
            long,
            help = "Semicolon-separated UQFF files, relative to the model root"
        )]
        uqff: Option<String>,
        #[arg(long, default_value_t = 4)]
        max_seqs: usize,
        #[arg(long)]
        model_home: Option<PathBuf>,
        #[arg(long)]
        cpu: bool,
    },
    /// Print this build's backend and protocol capabilities without loading a model.
    Doctor {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        model_home: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeManifest {
    schema_version: u8,
    backend: String,
    model: String,
    source: String,
    revision: String,
    quantization: String,
    license: String,
    integrity: String,
    model_home: PathBuf,
    endpoint: String,
    created_at_unix: u64,
}

struct ServeConfig {
    model: String,
    host: String,
    port: u16,
    quant: String,
    uqff: Option<String>,
    max_seqs: usize,
    model_home: Option<PathBuf>,
    cpu: bool,
}

fn default_model_home() -> Result<PathBuf> {
    let home = std::env::var_os("HII_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|path| path.join(".hii")))
        .context("could not determine HII runtime directory")?;
    Ok(home.join("models"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn ensure_model_home(path: &Path) -> Result<()> {
    fs::create_dir_all(path.join("huggingface"))
        .with_context(|| format!("failed to create {}", path.display()))
}

fn write_manifest(path: &Path, manifest: &RuntimeManifest) -> Result<()> {
    let destination = path.join("runtime-manifest.json");
    let temporary = path.join("runtime-manifest.json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(manifest)?)
        .with_context(|| format!("failed to write {}", temporary.display()))?;
    fs::rename(&temporary, &destination)
        .with_context(|| format!("failed to publish {}", destination.display()))?;
    Ok(())
}

fn inventory_files(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
        if path.is_dir() {
            for entry in fs::read_dir(path)? {
                visit(&entry?.path(), files)?;
            }
        } else if path.is_file() {
            files.push(path.to_path_buf());
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn hash_inventory(root: &Path) -> Result<String> {
    let mut digest = Sha256::new();
    for file in inventory_files(root)? {
        digest.update(
            file.strip_prefix(root)
                .unwrap_or(&file)
                .to_string_lossy()
                .as_bytes(),
        );
        digest.update([0]);
        let mut handle = fs::File::open(&file)?;
        std::io::copy(&mut handle, &mut DigestWriter(&mut digest))?;
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

struct DigestWriter<'a>(&'a mut Sha256);

impl std::io::Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn detect_license(root: &Path) -> Result<String> {
    for file in inventory_files(root)? {
        let name = file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !name.eq_ignore_ascii_case("readme.md") {
            continue;
        }
        let text = fs::read_to_string(file)?;
        if let Some(license) = text.lines().take(80).find_map(|line| {
            line.trim()
                .strip_prefix("license:")
                .map(str::trim)
                .filter(|value| !value.is_empty())
        }) {
            return Ok(license.trim_matches(['\'', '"']).to_string());
        }
    }
    Ok("unknown-model-license".into())
}

fn capabilities(model_home: &Path) -> Value {
    json!({
        "runtime": "hii-native-runner",
        "backend": if cfg!(feature = "metal") { "mistral.rs-metal" } else { "mistral.rs-cpu" },
        "metal": cfg!(feature = "metal"),
        "mlxWorker": {
            "status": "experimental-contract",
            "transport": "unix-socket",
            "runtimeDependency": "none"
        },
        "modelHome": model_home,
        "loopback": format!("http://{DEFAULT_HOST}:{DEFAULT_PORT}"),
        "protocol": ["GET /health", "GET /v1/models", "POST /v1/chat/completions", "GET /v1/hii/metrics"],
        "defaultModel": DEFAULT_MODEL,
        "defaultQuantization": "4",
        "modelAcquisition": "explicit-on-start"
    })
}

async fn metrics() -> Json<Value> {
    Json(json!({
        "runtime": "hii-native-runner",
        "backend": if cfg!(feature = "metal") { "mistral.rs-metal" } else { "mistral.rs-cpu" },
        "metricsSource": "mistral.rs response usage",
        "hint": "Completion responses expose prompt and completion token throughput."
    }))
}

async fn serve(config: ServeConfig) -> Result<()> {
    let ServeConfig {
        model,
        host,
        port,
        quant,
        uqff,
        max_seqs,
        model_home: requested_home,
        cpu,
    } = config;
    let ip: IpAddr = host
        .parse()
        .with_context(|| format!("invalid host {host}"))?;
    if ip != IpAddr::V4(Ipv4Addr::LOCALHOST) && ip != IpAddr::V6(std::net::Ipv6Addr::LOCALHOST) {
        bail!("native runner only binds loopback; requested {host}");
    }
    let model_home = requested_home.unwrap_or(default_model_home()?);
    ensure_model_home(&model_home)?;
    let cache = model_home.join("huggingface");
    let endpoint = format!("http://{host}:{port}");
    let mut manifest = RuntimeManifest {
        schema_version: 1,
        backend: if cfg!(feature = "metal") {
            "mistral.rs-metal"
        } else {
            "mistral.rs-cpu"
        }
        .into(),
        model: model.clone(),
        source: if Path::new(&model).exists() {
            "local-path"
        } else {
            "huggingface"
        }
        .into(),
        revision: "main".into(),
        quantization: uqff.clone().unwrap_or_else(|| format!("isq-{quant}")),
        license: "pending-model-card-read".into(),
        integrity: "pending-load".into(),
        model_home: model_home.clone(),
        endpoint: endpoint.clone(),
        created_at_unix: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
    };
    write_manifest(&model_home, &manifest)?;

    let quant_label = uqff
        .as_deref()
        .map(|files| format!("UQFF {files}"))
        .unwrap_or_else(|| format!("ISQ {quant}"));
    eprintln!(
        "hii-native-runner: loading {model} with {quant_label} into {}",
        cache.display()
    );
    let selected = ModelSelected::Plain {
        model_id: model.clone(),
        tokenizer_json: None,
        arch: None,
        dtype: ModelDType::Auto,
        topology: None,
        organization: None,
        write_uqff: None,
        from_uqff: uqff.clone(),
        imatrix: None,
        calibration_file: None,
        max_seq_len: AutoDeviceMapParams::DEFAULT_MAX_SEQ_LEN,
        max_batch_size: AutoDeviceMapParams::DEFAULT_MAX_BATCH_SIZE,
        hf_cache_path: Some(cache.clone()),
        matformer_config_path: None,
        matformer_slice_name: None,
    };
    let mut builder = MistralRsForServerBuilder::new()
        .with_model(selected)
        .with_max_seqs(max_seqs)
        .with_prefix_cache_n(16)
        .set_paged_attn(Some(!cpu))
        .with_cpu(cpu);
    if uqff.is_none() {
        builder = builder.with_in_situ_quant(quant);
    }
    let state = builder
        .build()
        .await
        .context("mistral.rs failed to load the selected model")?;
    let inventory_root = if Path::new(&model).exists() {
        PathBuf::from(&model)
    } else {
        cache
    };
    manifest.license = detect_license(&inventory_root)?;
    manifest.integrity = hash_inventory(&inventory_root)?;
    write_manifest(&model_home, &manifest)?;
    let api = MistralRsServerRouterBuilder::new()
        .with_mistralrs(state)
        .with_allowed_origins(vec![endpoint.clone()])
        .build()
        .await?
        .merge(Router::new().route("/v1/hii/metrics", get(metrics)));
    let address = SocketAddr::new(ip, port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("hii-native-runner: ready at {endpoint}");
    axum::serve(listener, api)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Serve {
            model,
            host,
            port,
            quant,
            uqff,
            max_seqs,
            model_home,
            cpu,
        } => {
            serve(ServeConfig {
                model,
                host,
                port,
                quant,
                uqff,
                max_seqs,
                model_home,
                cpu,
            })
            .await
        }
        Command::Doctor { json, model_home } => {
            let model_home = model_home.unwrap_or(default_model_home()?);
            ensure_model_home(&model_home)?;
            let report = capabilities(&model_home);
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("HII native runner");
                println!(
                    "backend:    {}",
                    report["backend"].as_str().unwrap_or("unknown")
                );
                println!("model home: {}", model_home.display());
                println!("endpoint:   http://{DEFAULT_HOST}:{DEFAULT_PORT}");
                println!("acquire:    explicit on start");
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_home_is_isolated_from_ollama_storage() {
        let temp = tempfile::tempdir().unwrap();
        ensure_model_home(temp.path()).unwrap();
        assert!(temp.path().join("huggingface").is_dir());
        assert!(!temp.path().join("blobs").exists());
    }

    #[test]
    fn manifest_is_atomically_published() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = RuntimeManifest {
            schema_version: 1,
            backend: "mistral.rs-metal".into(),
            model: DEFAULT_MODEL.into(),
            source: "huggingface".into(),
            revision: "main".into(),
            quantization: "4".into(),
            license: "model-card-required".into(),
            integrity: "huggingface-cache-metadata".into(),
            model_home: temp.path().into(),
            endpoint: format!("http://{DEFAULT_HOST}:{DEFAULT_PORT}"),
            created_at_unix: 1,
        };
        write_manifest(temp.path(), &manifest).unwrap();
        let decoded: RuntimeManifest =
            serde_json::from_slice(&fs::read(temp.path().join("runtime-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(decoded.model, DEFAULT_MODEL);
        assert!(!temp.path().join("runtime-manifest.json.tmp").exists());
    }

    #[test]
    fn inventory_hash_and_license_change_with_source() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("README.md"),
            "---\nlicense: apache-2.0\n---\n",
        )
        .unwrap();
        fs::write(temp.path().join("weights.bin"), b"first").unwrap();
        let first = hash_inventory(temp.path()).unwrap();
        assert_eq!(detect_license(temp.path()).unwrap(), "apache-2.0");
        fs::write(temp.path().join("weights.bin"), b"second").unwrap();
        assert_ne!(first, hash_inventory(temp.path()).unwrap());
    }
}
