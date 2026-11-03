//! Persistent execution harness mode and macOS network confinement.
//!
//! `entry` is intended to run before any CLI delegate. It handles `hii harness`
//! control commands and re-execs ordinary invocations under the saved mode.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const STATE_FILE: &str = "harness-mode.json";
const REEXEC_MARKER: &str = "HII_HARNESS_AIRPLANE_REEXEC";
const AIRPLANE_PROFILE: &str = r#"(version 1)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(deny network-bind)
(allow default)
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Normal,
    Airplane,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Airplane => "airplane",
        }
    }
}

/// Handles harness controls or applies the stored mode to this invocation.
/// `raw_args` excludes argv[0], as returned by `std::env::args().skip(1)`.
pub fn entry(runtime: &Path, raw_args: &[String]) -> Result<Option<ExitCode>, String> {
    if crate::first_command(raw_args) == Some("harness") {
        // Mode changes are control-plane commands. A `normal` command invoked
        // under airplane mode cannot unlock its own current process.
        return Ok(None);
    }

    match read_mode(runtime)? {
        Mode::Normal => Ok(None),
        Mode::Airplane => enforce_airplane(raw_args),
    }
}

/// Execute the `hii harness <mode>` command arm from the CLI dispatcher.
pub fn command(runtime: &Path, mode: &str) -> Result<ExitCode, String> {
    match mode {
        "status" => {
            println!("Harness mode: {}", read_mode(runtime)?.as_str());
            Ok(ExitCode::SUCCESS)
        }
        "normal" => {
            write_mode(runtime, Mode::Normal)?;
            println!("Harness mode set to normal (takes effect on the next invocation).");
            Ok(ExitCode::SUCCESS)
        }
        "airplane" => {
            #[cfg(not(target_os = "macos"))]
            return Err(
                "airplane harness mode is unsupported on this platform; mode was not changed"
                    .into(),
            );
            #[cfg(target_os = "macos")]
            {
                write_mode(runtime, Mode::Airplane)?;
                println!("Harness mode set to airplane (network confinement starts on the next invocation).");
                Ok(ExitCode::SUCCESS)
            }
        }
        _ => Err("usage: hii harness [status|normal|airplane]".into()),
    }
}

fn state_path(runtime: &Path) -> PathBuf {
    runtime.join(STATE_FILE)
}

fn read_mode(runtime: &Path) -> Result<Mode, String> {
    let path = state_path(runtime);
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Mode::Normal),
        Err(error) => {
            return Err(format!(
                "cannot read harness mode {}: {error}",
                path.display()
            ))
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&data)
        .map_err(|error| format!("invalid harness mode file {}: {error}", path.display()))?;
    match value.get("mode").and_then(serde_json::Value::as_str) {
        Some("normal") => Ok(Mode::Normal),
        Some("airplane") => Ok(Mode::Airplane),
        _ => Err(format!("invalid harness mode in {}", path.display())),
    }
}

fn write_mode(runtime: &Path, mode: Mode) -> Result<(), String> {
    fs::create_dir_all(runtime).map_err(|error| {
        format!(
            "cannot create runtime directory {}: {error}",
            runtime.display()
        )
    })?;
    let path = state_path(runtime);
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(format!(
                "refusing to replace non-regular harness mode path {}",
                path.display()
            ));
        }
    }
    let temp = runtime.join(format!(".{STATE_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("cannot create {}: {error}", temp.display()))?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({"version": 1, "mode": mode.as_str()}),
        )
        .map_err(|error| format!("cannot encode harness mode: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("cannot write harness mode: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync harness mode: {error}"))?;
        fs::rename(&temp, &path)
            .map_err(|error| format!("cannot atomically replace {}: {error}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(target_os = "macos")]
fn enforce_airplane(raw_args: &[String]) -> Result<Option<ExitCode>, String> {
    if std::env::var_os(REEXEC_MARKER).is_some() {
        return if confinement_proven() {
            Ok(None)
        } else {
            Err("airplane re-exec marker is present but network confinement could not be proven; refusing to run".into())
        };
    }
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot locate hii executable: {error}"))?;
    let status = Command::new("/usr/bin/sandbox-exec")
        .arg("-p")
        .arg(AIRPLANE_PROFILE)
        .arg(exe)
        .args(raw_args)
        .env(REEXEC_MARKER, "1")
        .status()
        .map_err(|error| {
            format!("cannot start macOS sandbox-exec; airplane mode fails closed: {error}")
        })?;
    match status.code() {
        Some(code) => Ok(Some(ExitCode::from(code.clamp(0, 255) as u8))),
        None => Ok(Some(ExitCode::from(1))),
    }
}

#[cfg(not(target_os = "macos"))]
fn enforce_airplane(_: &[String]) -> Result<Option<ExitCode>, String> {
    Err("airplane harness mode is unsupported on this platform; refusing to run without network confinement".into())
}

#[cfg(target_os = "macos")]
fn confinement_proven() -> bool {
    (unsafe { sandbox_check(std::process::id() as i32, std::ptr::null(), 0) == 1 })
        && remote_network_denied()
}

#[cfg(target_os = "macos")]
fn remote_network_denied() -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    // TEST-NET-1 is reserved for documentation. A blocking EPERM/EACCES proves
    // policy denial; timeout, routing failure, and refusal are not proof.
    let target: SocketAddr = "203.0.113.1:443".parse().expect("constant socket address");
    matches!(TcpStream::connect_timeout(&target, Duration::from_millis(500)),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn sandbox_check(pid: i32, operation: *const libc::c_char, filter_type: i32, ...) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn absent_file_defaults_normal_and_persists_mode() {
        let temp = tempdir().unwrap();
        assert_eq!(read_mode(temp.path()).unwrap(), Mode::Normal);
        write_mode(temp.path(), Mode::Airplane).unwrap();
        assert_eq!(read_mode(temp.path()).unwrap(), Mode::Airplane);
        write_mode(temp.path(), Mode::Normal).unwrap();
        assert_eq!(read_mode(temp.path()).unwrap(), Mode::Normal);
    }

    #[test]
    fn refuses_symlink_state_file() {
        let temp = tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::write(&outside, "safe").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, state_path(temp.path())).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, state_path(temp.path())).unwrap();
        assert!(write_mode(temp.path(), Mode::Airplane).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "safe");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sandbox_profile_blocks_remote_and_allows_loopback_in_subprocess() {
        use std::net::TcpListener;
        use std::os::unix::net::UnixListener;
        use std::thread;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let accept = thread::spawn(move || listener.accept().unwrap());
        let unix_dir = tempfile::tempdir().unwrap();
        let unix_path = unix_dir.path().join("listener.sock");
        let unix_listener = UnixListener::bind(&unix_path).unwrap();
        let script = format!(
            r#"import errno, socket, sys
c=socket.socket(); c.settimeout(2); c.connect(('127.0.0.1',{})); c.close()
u=socket.socket(socket.AF_UNIX)
try:
 u.connect({:?}); sys.exit(10)
except OSError as e:
 if e.errno not in (errno.EPERM, errno.EACCES): sys.exit(11)
try:
 r=socket.socket(); r.settimeout(1); r.connect(('203.0.113.1',443)); sys.exit(8)
except OSError as e:
 sys.exit(0 if e.errno in (errno.EPERM, errno.EACCES) else 9)
"#,
            address.port(),
            unix_path.to_string_lossy()
        );
        let status = Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(AIRPLANE_PROFILE)
            .arg("/usr/bin/python3")
            .arg("-c")
            .arg(script)
            .status()
            .unwrap();
        accept.join().unwrap();
        assert_eq!(status.code(), Some(0));
        drop(unix_listener);
    }
}
