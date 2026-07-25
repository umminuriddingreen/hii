mod browser;

use serde::Serialize;
use std::{
    fs::{create_dir_all, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager, RunEvent, Url, WindowEvent};

const DEFAULT_HII_PORT: u16 = 3042;

struct HiiServer(Mutex<ServerState>);

struct ServerState {
    child: Option<Child>,
    url: String,
}

#[derive(Serialize)]
struct DesktopSurface {
    name: &'static str,
    surface: &'static str,
    server: String,
}

#[tauri::command]
fn desktop_surface(server: tauri::State<'_, HiiServer>) -> DesktopSurface {
    DesktopSurface {
        name: "HII",
        surface: "hii",
        server: server.0.lock().map(|state| state.url.clone()).unwrap_or_default(),
    }
}

fn hii_is_reachable(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/knowledge HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.contains("200 OK")
        && response.contains("\"authority\":\"hii-database\"")
}

fn available_port() -> Result<u16, String> {
    if TcpListener::bind(("127.0.0.1", DEFAULT_HII_PORT)).is_ok() {
        return Ok(DEFAULT_HII_PORT);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| err.to_string())?;
    listener.local_addr().map(|address| address.port()).map_err(|err| err.to_string())
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

fn spawn_hii_server(app: &tauri::App, port: u16) -> Result<Child, String> {
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
        .env("PORT", port.to_string())
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
    if let Ok(mut state) = app.state::<HiiServer>().0.lock() {
        if let Some(mut process) = state.child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(HiiServer(Mutex::new(ServerState {
            child: None,
            url: String::new(),
        })))
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, ShortcutState,
                };

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state != ShortcutState::Pressed
                                || !shortcut.matches(Modifiers::ALT, Code::Space)
                            {
                                return;
                            }
                            let Some(window) = app.get_webview_window("main") else {
                                return;
                            };
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                            let on_workspace =
                                window.url().map(|url| url.path() == "/").unwrap_or(false);
                            if on_workspace {
                                let _ = window.eval(
                                    "window.dispatchEvent(new CustomEvent('hii:summon', { detail: { source: 'option-space' } }))",
                                );
                                let _ = window.emit(
                                    "hii://summon",
                                    serde_json::json!({
                                        "source": "option-space"
                                    }),
                                );
                            } else if let Ok(mut url) = window.url() {
                                url.set_path("/");
                                url.set_query(Some("summon=1"));
                                let _ = window.navigate(url);
                            }
                        })
                        .build(),
                )?;
                if let Err(error) = app.global_shortcut().register("alt+space") {
                    eprintln!("HII could not register Option+Space: {error}");
                }
            }

            let (port, child) = if hii_is_reachable(DEFAULT_HII_PORT) {
                (DEFAULT_HII_PORT, None)
            } else {
                let port = available_port()?;
                (port, Some(spawn_hii_server(app, port)?))
            };
            let hii_url = format!("http://127.0.0.1:{port}");
            *app.state::<HiiServer>().0.lock().map_err(|err| err.to_string())? = ServerState {
                child,
                url: hii_url.clone(),
            };

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let hii_url = Url::parse(&hii_url).expect("valid local HII URL");
                for _ in 0..80 {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let loaded = window
                            .url()
                            .map(|url| url.as_str().starts_with(hii_url.as_str()))
                            .unwrap_or(false);
                        if loaded {
                            let _ = window.set_focus();
                            return;
                        }
                        if hii_is_reachable(port) {
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
