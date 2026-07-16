mod browser;

use serde::Serialize;
use std::{
    fs::{create_dir_all, OpenOptions},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, RunEvent, Url, WindowEvent};

const HII_URL: &str = "http://127.0.0.1:3042";

struct HiiServer(Mutex<Option<Child>>);

#[derive(Serialize)]
struct DesktopSurface {
    name: &'static str,
    surface: &'static str,
    server: &'static str,
}

#[tauri::command]
fn desktop_surface() -> DesktopSurface {
    DesktopSurface {
        name: "HII",
        surface: "hii",
        server: HII_URL,
    }
}

fn hii_is_reachable() -> bool {
    let addr: SocketAddr = "127.0.0.1:3042".parse().expect("valid local HII address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn runtime_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not available".to_string())?;
    Ok(Path::new(&home).join(".hii"))
}

fn resource_root(app: &tauri::App) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        return Ok(resource_dir);
    }

    // A normal Finder/LaunchServices launch provides the bundle resource path.
    // Directly invoking Contents/MacOS/hii does not on every macOS version, so
    // derive the same location from the executable instead of aborting setup.
    let executable = std::env::current_exe().map_err(|err| err.to_string())?;
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("Cannot resolve HII.app from {}", executable.display()))?;
    let resource_dir = contents.join("Resources");
    if resource_dir.is_dir() {
        Ok(resource_dir)
    } else {
        Err(format!("HII resources are missing at {}", resource_dir.display()))
    }
}

fn spawn_hii_server(app: &tauri::App) -> Result<Child, String> {
    let resource_dir = resource_root(app)?;
    let app_dir = resource_dir.join("hii-app");
    let node = app_dir.join("bin").join("node");
    let server_dir = app_dir.join("server");
    let entry = server_dir.join("server.mjs");
    if !node.is_file() || !entry.is_file() {
        return Err(format!("HII portable resources are incomplete at {}", app_dir.display()));
    }

    let runtime = runtime_root()?;
    let log_dir = runtime.join("logs");
    create_dir_all(&log_dir).map_err(|err| err.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("desktop-server.log"))
        .map_err(|err| err.to_string())?;
    let error_log = log.try_clone().map_err(|err| err.to_string())?;

    Command::new(node)
        .arg("server.mjs")
        .current_dir(server_dir)
        .env("PORT", "3042")
        .env("HOST", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("HII_TAURI", "1")
        .env("HII_RUNTIME_DIR", runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn()
        .map_err(|err| err.to_string())
}

fn stop_hii_server(app: &tauri::AppHandle) {
    if let Ok(mut child) = app.state::<HiiServer>().0.lock() {
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(HiiServer(Mutex::new(None)))
        .setup(|app| {
            if !hii_is_reachable() {
                let child = spawn_hii_server(app)?;
                *app.state::<HiiServer>().0.lock().map_err(|err| err.to_string())? = Some(child);
            }

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let hii_url = Url::parse(HII_URL).expect("valid local HII URL");
                for _ in 0..80 {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let loaded = window
                            .url()
                            .map(|url| url.as_str().starts_with(HII_URL))
                            .unwrap_or(false);
                        if loaded {
                            let _ = window.set_focus();
                            return;
                        }
                        if hii_is_reachable() {
                            let _ = window.navigate(hii_url.clone());
                        }
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                stop_hii_server(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![desktop_surface, browser::browser_navigate])
        .build(tauri::generate_context!())
        .expect("error while building HII desktop interface");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_hii_server(app_handle);
        }
    });
}
