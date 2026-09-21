//! Read-only, source-scoped email access owned by the HII runtime.
//!
//! Account metadata is private local state. Passwords and provider app-passwords
//! live in the operating-system credential vault, never in HII files, receipts,
//! model context, or command-line arguments.

use crate::{config::AppPaths, store};
use futures_util::TryStreamExt;
use mailparse::MailHeaderMap;
use rustls::{pki_types::ServerName, ClientConfig, RootCertStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "hii.mail";
const MAX_LIMIT: usize = 50;
const MAX_READ_BYTES: usize = 65_536;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub id: String,
    pub email: String,
    pub host: String,
    pub port: u16,
    pub mailbox: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MailConfig {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    accounts: Vec<MailAccount>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSummary {
    pub account: String,
    pub mailbox: String,
    pub uid: u32,
    pub unread: bool,
    pub date: Option<String>,
    pub from: Option<String>,
    pub subject: Option<String>,
    pub message_id: Option<String>,
}

fn schema_version() -> u32 {
    1
}

fn config_path(runtime: &Path) -> PathBuf {
    runtime.join("mail").join("accounts.json")
}

fn receipt_path(runtime: &Path) -> PathBuf {
    runtime.join("mail").join("receipts.jsonl")
}

fn keyring_user(account: &MailAccount) -> String {
    format!("{}:{}", account.id, account.email)
}

fn credential(account: &MailAccount) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &keyring_user(account))
        .map_err(|error| format!("credential vault is unavailable: {error}"))
}

fn load_config(runtime: &Path) -> Result<MailConfig, String> {
    let path = config_path(runtime);
    if !path.exists() {
        return Ok(MailConfig {
            schema_version: schema_version(),
            accounts: Vec::new(),
        });
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let config: MailConfig = serde_json::from_str(&text)
        .map_err(|error| format!("invalid mail config {}: {error}", path.display()))?;
    if config.schema_version != schema_version() {
        return Err(format!(
            "unsupported mail config schema {}",
            config.schema_version
        ));
    }
    Ok(config)
}

fn account(runtime: &Path, id: &str) -> Result<MailAccount, String> {
    load_config(runtime)?
        .accounts
        .into_iter()
        .find(|account| account.id == id)
        .ok_or_else(|| format!("mail account not configured: {id}"))
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("account id must use 1-64 letters, numbers, dashes, or underscores".into());
    }
    Ok(())
}

fn validate_imap_atom(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 || value.contains(['\r', '\n', '\0']) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

pub fn add_account(paths: &AppPaths, value: MailAccount, password: &str) -> Result<Value, String> {
    store_account(paths, value, password, false)
}

pub fn setup_account(
    paths: &AppPaths,
    value: MailAccount,
    password: &str,
) -> Result<Value, String> {
    store_account(paths, value, password, true)
}

fn store_account(
    paths: &AppPaths,
    mut value: MailAccount,
    password: &str,
    replace: bool,
) -> Result<Value, String> {
    validate_id(&value.id)?;
    validate_imap_atom("email", &value.email)?;
    validate_imap_atom("host", &value.host)?;
    validate_imap_atom("mailbox", &value.mailbox)?;
    if value.port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    if password.is_empty() {
        return Err("password cannot be empty".into());
    }
    value.host = value.host.trim().to_ascii_lowercase();
    value.email = value.email.trim().to_string();
    value.mailbox = value.mailbox.trim().to_string();

    let mut config = load_config(&paths.runtime)?;
    let existing = matching_account_index(&config.accounts, &value, replace);
    if existing.is_some() && !replace {
        return Err(format!(
            "mail account '{}' already exists; choose another id",
            value.id
        ));
    }
    let previous = existing.map(|index| config.accounts[index].clone());
    let was_existing = previous.is_some();
    if let Some(previous) = previous.as_ref() {
        value.id = previous.id.clone();
    }
    credential(&value)?
        .set_password(password)
        .map_err(|error| format!("could not save credential in the OS vault: {error}"))?;
    if let Some(index) = existing {
        config.accounts[index] = value.clone();
    } else {
        config.accounts.push(value.clone());
    }
    config
        .accounts
        .sort_by(|left, right| left.id.cmp(&right.id));
    if let Err(error) = store::write_json_private_atomic(&config_path(&paths.runtime), &config) {
        if !was_existing {
            let _ = credential(&value).and_then(|entry| {
                entry
                    .delete_credential()
                    .map_err(|delete_error| delete_error.to_string())
            });
        }
        return Err(error);
    }
    if let Some(previous) = previous {
        if keyring_user(&previous) != keyring_user(&value) {
            let _ = credential(&previous).and_then(|entry| {
                entry
                    .delete_credential()
                    .map_err(|delete_error| delete_error.to_string())
            });
        }
    }
    Ok(json!({
        "schemaVersion": 1,
        "kind": "hii.mail.account",
        "account": public_account(&value),
        "credentialStore": "operating-system",
        "capability": "hii.mail.read",
        "linked": true,
        "relinked": existing.is_some()
    }))
}

fn matching_account_index(
    accounts: &[MailAccount],
    value: &MailAccount,
    replace: bool,
) -> Option<usize> {
    accounts.iter().position(|account| {
        account.id == value.id || (replace && account.email.eq_ignore_ascii_case(&value.email))
    })
}

pub fn list_accounts(paths: &AppPaths) -> Result<Value, String> {
    let accounts = load_config(&paths.runtime)?
        .accounts
        .iter()
        .map(public_account)
        .collect::<Vec<_>>();
    Ok(json!({
        "schemaVersion": 1,
        "kind": "hii.mail.accounts",
        "accounts": accounts
    }))
}

fn public_account(account: &MailAccount) -> Value {
    json!({
        "id": account.id,
        "email": account.email,
        "host": account.host,
        "port": account.port,
        "mailbox": account.mailbox,
        "access": "read-only"
    })
}

pub fn search(
    paths: &AppPaths,
    account_id: &str,
    mailbox: Option<&str>,
    query: &str,
    limit: usize,
    actor: &str,
) -> Result<Value, String> {
    validate_imap_atom("query", query)?;
    let account = account(&paths.runtime, account_id)?;
    let mailbox = mailbox.unwrap_or(&account.mailbox);
    validate_imap_atom("mailbox", mailbox)?;
    let limit = limit.clamp(1, MAX_LIMIT);
    let password = Zeroizing::new(
        credential(&account)?
            .get_password()
            .map_err(|error| format!("could not read credential from the OS vault: {error}"))?,
    );
    let messages = run_async(search_async(
        &account,
        password.as_str(),
        mailbox,
        query,
        limit,
    ))?;
    append_receipt(
        &paths.runtime,
        actor,
        "mail.search",
        &account.id,
        mailbox,
        Some(query),
        messages.iter().map(|message| message.uid).collect(),
    )?;
    Ok(json!({
        "schemaVersion": 1,
        "kind": "hii.mail.search-result",
        "sourceGrant": { "account": account.id, "mailbox": mailbox, "query": query, "limit": limit },
        "messages": messages,
        "sideEffects": []
    }))
}

pub fn search_many(
    paths: &AppPaths,
    account_id: Option<&str>,
    mailbox: Option<&str>,
    query: &str,
    limit: usize,
    actor: &str,
) -> Result<Value, String> {
    let ids = match account_id {
        Some(id) => vec![id.to_string()],
        None => load_config(&paths.runtime)?
            .accounts
            .into_iter()
            .map(|account| account.id)
            .collect(),
    };
    if ids.is_empty() {
        return Err("no mail accounts are configured; run `hii mail add` first".into());
    }
    let mut messages = Vec::new();
    let mut errors = Vec::new();
    for id in ids {
        match search(paths, &id, mailbox, query, limit, actor) {
            Ok(value) => {
                if let Some(items) = value.get("messages").and_then(Value::as_array) {
                    messages.extend(items.iter().cloned());
                }
            }
            Err(error) => errors.push(json!({ "account": id, "error": error })),
        }
    }
    if messages.is_empty() && !errors.is_empty() {
        return Err(errors
            .iter()
            .filter_map(|item| {
                Some(format!(
                    "{}: {}",
                    item["account"].as_str()?,
                    item["error"].as_str()?
                ))
            })
            .collect::<Vec<_>>()
            .join("; "));
    }
    Ok(json!({
        "schemaVersion": 1,
        "kind": "hii.mail.global-search-result",
        "sourceGrant": { "account": account_id, "mailbox": mailbox, "query": query, "limitPerAccount": limit.clamp(1, MAX_LIMIT) },
        "messages": messages,
        "errors": errors,
        "sideEffects": []
    }))
}

pub fn read(
    paths: &AppPaths,
    account_id: &str,
    mailbox: Option<&str>,
    uid: u32,
    actor: &str,
) -> Result<Value, String> {
    if uid == 0 {
        return Err("uid must be greater than zero".into());
    }
    let account = account(&paths.runtime, account_id)?;
    let mailbox = mailbox.unwrap_or(&account.mailbox);
    validate_imap_atom("mailbox", mailbox)?;
    let password = Zeroizing::new(
        credential(&account)?
            .get_password()
            .map_err(|error| format!("could not read credential from the OS vault: {error}"))?,
    );
    let message = run_async(read_async(&account, password.as_str(), mailbox, uid))?;
    append_receipt(
        &paths.runtime,
        actor,
        "mail.read",
        &account.id,
        mailbox,
        None,
        vec![uid],
    )?;
    Ok(json!({
        "schemaVersion": 1,
        "kind": "hii.mail.message",
        "sourceGrant": { "account": account.id, "mailbox": mailbox, "uid": uid },
        "message": message,
        "truncatedAtBytes": MAX_READ_BYTES,
        "sideEffects": []
    }))
}

fn run_async<T>(future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("could not start mail runtime: {error}"))?
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(30), future)
                .await
                .map_err(|_| "mail provider operation timed out after 30 seconds".to_string())?
        })
}

async fn session(
    account: &MailAccount,
    password: &str,
) -> Result<async_imap::Session<tokio_rustls::client::TlsStream<TcpStream>>, String> {
    ensure_crypto_provider()?;
    let certificates = rustls_native_certs::load_native_certs();
    if !certificates.errors.is_empty() && certificates.certs.is_empty() {
        return Err("could not load operating-system TLS certificates".into());
    }
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(certificates.certs);
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name = ServerName::try_from(account.host.clone())
        .map_err(|_| "mail host is not a valid TLS server name".to_string())?;
    let tcp = TcpStream::connect((account.host.as_str(), account.port))
        .await
        .map_err(|error| format!("could not connect to mail provider: {error}"))?;
    let tls = TlsConnector::from(Arc::new(config))
        .connect(server_name, tcp)
        .await
        .map_err(|error| format!("mail TLS connection failed: {error}"))?;
    let mut client = async_imap::Client::new(tls);
    client
        .read_response()
        .await
        .map_err(|error| format!("mail provider greeting failed: {error}"))?
        .ok_or_else(|| "mail provider closed before greeting".to_string())?;
    client
        .login(&account.email, password)
        .await
        .map_err(|(error, _)| {
            format!("mail login failed; check provider IMAP/app-password settings: {error}")
        })
}

fn ensure_crypto_provider() -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return Ok(());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        Ok(())
    } else {
        Err("could not initialize the TLS crypto provider".into())
    }
}

async fn search_async(
    account: &MailAccount,
    password: &str,
    mailbox: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<MailSummary>, String> {
    let mut session = session(account, password).await?;
    session
        .select(mailbox)
        .await
        .map_err(|error| format!("could not select mailbox: {error}"))?;
    let mut uids = session
        .uid_search(query)
        .await
        .map_err(|error| format!("mail search failed: {error}"))?
        .into_iter()
        .collect::<Vec<_>>();
    uids.sort_unstable_by(|left, right| right.cmp(left));
    uids.truncate(limit);
    if uids.is_empty() {
        let _ = session.logout().await;
        return Ok(Vec::new());
    }
    let set = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let fetches = session
        .uid_fetch(set, "(UID FLAGS BODY.PEEK[HEADER])")
        .await
        .map_err(|error| format!("mail metadata fetch failed: {error}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| format!("mail metadata response failed: {error}"))?;
    let mut messages = fetches
        .into_iter()
        .filter_map(|fetch| {
            let uid = fetch.uid?;
            let parsed = mailparse::parse_headers(fetch.header()?).ok()?.0;
            let unread = !fetch
                .flags()
                .any(|flag| matches!(flag, async_imap::types::Flag::Seen));
            Some(MailSummary {
                account: account.id.clone(),
                mailbox: mailbox.to_string(),
                uid,
                unread,
                date: parsed.get_first_value("Date"),
                from: parsed.get_first_value("From"),
                subject: parsed.get_first_value("Subject"),
                message_id: parsed.get_first_value("Message-ID"),
            })
        })
        .collect::<Vec<_>>();
    messages.sort_by(|left, right| right.uid.cmp(&left.uid));
    let _ = session.logout().await;
    Ok(messages)
}

async fn read_async(
    account: &MailAccount,
    password: &str,
    mailbox: &str,
    uid: u32,
) -> Result<Value, String> {
    let mut session = session(account, password).await?;
    session
        .select(mailbox)
        .await
        .map_err(|error| format!("could not select mailbox: {error}"))?;
    let query = format!("(UID FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.{MAX_READ_BYTES}>)");
    let mut fetches = session
        .uid_fetch(uid.to_string(), query)
        .await
        .map_err(|error| format!("mail message fetch failed: {error}"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|error| format!("mail message response failed: {error}"))?;
    let fetch = fetches
        .pop()
        .ok_or_else(|| format!("message uid {uid} was not found"))?;
    let headers = fetch
        .header()
        .ok_or_else(|| "mail provider returned no message headers".to_string())?;
    let raw_text = fetch.text().unwrap_or_default();
    let mut raw = Vec::with_capacity(headers.len() + raw_text.len() + 4);
    raw.extend_from_slice(headers);
    raw.extend_from_slice(b"\r\n");
    raw.extend_from_slice(raw_text);
    let parsed =
        mailparse::parse_mail(&raw).map_err(|error| format!("could not parse message: {error}"))?;
    let body = preferred_body(&parsed).unwrap_or_else(|| String::from_utf8_lossy(raw_text).into());
    let unread = !fetch
        .flags()
        .any(|flag| matches!(flag, async_imap::types::Flag::Seen));
    let _ = session.logout().await;
    Ok(json!({
        "account": account.id,
        "mailbox": mailbox,
        "uid": uid,
        "unread": unread,
        "date": parsed.headers.get_first_value("Date"),
        "from": parsed.headers.get_first_value("From"),
        "to": parsed.headers.get_first_value("To"),
        "cc": parsed.headers.get_first_value("Cc"),
        "subject": parsed.headers.get_first_value("Subject"),
        "messageId": parsed.headers.get_first_value("Message-ID"),
        "body": body
    }))
}

fn preferred_body(message: &mailparse::ParsedMail<'_>) -> Option<String> {
    if message.ctype.mimetype.eq_ignore_ascii_case("text/plain") {
        return message.get_body().ok();
    }
    for part in &message.subparts {
        if let Some(body) = preferred_body(part) {
            return Some(body);
        }
    }
    if message.ctype.mimetype.eq_ignore_ascii_case("text/html") {
        return message.get_body().ok();
    }
    None
}

fn append_receipt(
    runtime: &Path,
    actor: &str,
    action: &str,
    account: &str,
    mailbox: &str,
    query: Option<&str>,
    uids: Vec<u32>,
) -> Result<(), String> {
    let path = receipt_path(runtime);
    let parent = path.parent().expect("mail receipt path has parent");
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    store::set_directory_mode(parent)?;
    let query_hash = query.map(|value| format!("{:x}", Sha256::digest(value.as_bytes())));
    let receipt = json!({
        "schemaVersion": 1,
        "kind": "hii.mail.receipt",
        "id": uuid::Uuid::new_v4().to_string(),
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "actor": actor,
        "action": action,
        "source": { "account": account, "mailbox": mailbox, "querySha256": query_hash, "uids": uids },
        "sideEffects": [],
        "contentPersisted": false
    });
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("could not open {}: {error}", path.display()))?;
    serde_json::to_writer(&mut file, &receipt).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_imap_command_injection() {
        assert!(validate_imap_atom("query", "UNSEEN\r\nLOGOUT").is_err());
        assert!(validate_imap_atom("query", "UNSEEN SINCE 1-Sep-2026").is_ok());
    }

    #[test]
    fn account_config_round_trips_without_a_secret() {
        let temp = tempfile::tempdir().unwrap();
        let config = MailConfig {
            schema_version: 1,
            accounts: vec![MailAccount {
                id: "school".into(),
                email: "student@example.edu".into(),
                host: "imap.example.edu".into(),
                port: 993,
                mailbox: "INBOX".into(),
            }],
        };
        store::write_json_private_atomic(&config_path(temp.path()), &config).unwrap();
        let loaded = load_config(temp.path()).unwrap();
        assert_eq!(loaded.accounts, config.accounts);
        let raw = fs::read_to_string(config_path(temp.path())).unwrap();
        assert!(!raw.to_ascii_lowercase().contains("password"));
    }

    #[test]
    fn receipts_persist_scope_but_not_query_text() {
        let temp = tempfile::tempdir().unwrap();
        append_receipt(
            temp.path(),
            "test-agent",
            "mail.search",
            "school",
            "INBOX",
            Some("FROM professor@example.edu"),
            vec![42],
        )
        .unwrap();
        let raw = fs::read_to_string(receipt_path(temp.path())).unwrap();
        assert!(raw.contains("mail.search"));
        assert!(raw.contains("42"));
        assert!(!raw.contains("professor@example.edu"));
    }

    #[test]
    fn prefers_decoded_plain_text_over_html() {
        let raw = b"Content-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello=20HII\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>Hello HII</b>\r\n--x--\r\n";
        let parsed = mailparse::parse_mail(raw).unwrap();
        assert_eq!(preferred_body(&parsed).as_deref(), Some("Hello HII"));
    }

    #[test]
    fn mail_tls_selects_an_explicit_crypto_provider() {
        ensure_crypto_provider().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn guided_setup_relinks_the_same_email_case_insensitively() {
        let existing = MailAccount {
            id: "gmail".into(),
            email: "Person@Gmail.com".into(),
            host: "imap.gmail.com".into(),
            port: 993,
            mailbox: "INBOX".into(),
        };
        let requested = MailAccount {
            id: "person-gmail".into(),
            email: "person@gmail.com".into(),
            host: "imap.gmail.com".into(),
            port: 993,
            mailbox: "INBOX".into(),
        };
        assert_eq!(
            matching_account_index(&[existing.clone()], &requested, true),
            Some(0)
        );
        assert_eq!(matching_account_index(&[existing], &requested, false), None);
    }
}
