mod browser;

use serde::Serialize;
use std::{
    fs::{create_dir_all, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, Url, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

const DEFAULT_HII_PORT: u16 = 3042;
const NOTCH_WIDTH: f64 = 460.0;
const NOTCH_COLLAPSED_HEIGHT: f64 = 52.0;
const NOTCH_EXPANDED_HEIGHT: f64 = 320.0;
const MENU_FOCUS_WORKSPACE: &str = "hii.focus-workspace";
const MENU_COMMAND_PALETTE: &str = "hii.command-palette";
const MENU_OPEN_BROWSER: &str = "hii.open-browser";
const MENU_FIT_ALL: &str = "hii.fit-all";
const MENU_REFRESH_SPACE: &str = "hii.refresh-space";
const MENU_DEVELOP_HII: &str = "hii.develop-hii";

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
        server: server
            .0
            .lock()
            .map(|state| state.url.clone())
            .unwrap_or_default(),
    }
}

fn ensure_cursor_bar(app: &tauri::AppHandle, server_url: &str) -> Result<(), String> {
    if app.get_webview_window("cursor-bar").is_some() {
        return Ok(());
    }
    let url = Url::parse(&format!("{}/notch", server_url.trim_end_matches('/')))
        .map_err(|error| error.to_string())?;
    WebviewWindowBuilder::new(app, "cursor-bar", WebviewUrl::External(url))
        .title("HII Notch")
        .inner_size(NOTCH_WIDTH, NOTCH_COLLAPSED_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(true)
        .focused(false)
        .visible(true)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn show_cursor_bar(app: &tauri::AppHandle) -> Result<(), String> {
    let server_url = app
        .state::<HiiServer>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .url
        .clone();
    if server_url.is_empty() {
        return Err("HII is still starting.".to_string());
    }
    ensure_cursor_bar(app, &server_url)?;
    set_notch_expanded(app.clone(), true)?;
    let window = app
        .get_webview_window("cursor-bar")
        .ok_or_else(|| "HII Notch is unavailable.".to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .emit("hii://notch-opened", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_cursor_bar(app: tauri::AppHandle) -> Result<(), String> {
    set_notch_expanded(app, false)
}

#[tauri::command]
fn set_notch_expanded(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("cursor-bar")
        .ok_or_else(|| "HII Notch is unavailable.".to_string())?;
    let height = if expanded {
        NOTCH_EXPANDED_HEIGHT
    } else {
        NOTCH_COLLAPSED_HEIGHT
    };
    window
        .set_size(PhysicalSize::new(NOTCH_WIDTH, height))
        .map_err(|error| error.to_string())?;
    if let Some(monitor) = app.primary_monitor().map_err(|error| error.to_string())? {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = NOTCH_WIDTH * scale;
        let x = f64::from(area.position.x) + (f64::from(area.size.width) - width) / 2.0;
        let y = area.position.y;
        window
            .set_position(PhysicalPosition::new(x.round() as i32, y))
            .map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_hii_mode(app: tauri::AppHandle, route: String) -> Result<(), String> {
    if !matches!(route.as_str(), "/browser" | "/create" | "/workspace") {
        return Err("HII mode must be Browser, Create, or Workspace.".to_string());
    }
    let base = app
        .state::<HiiServer>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .url
        .clone();
    let url = Url::parse(&format!("{}{route}", base.trim_end_matches('/')))
        .map_err(|error| error.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "HII workspace window is unavailable.".to_string())?;
    window.navigate(url).map_err(|error| error.to_string())?;
    focus_workspace(&app)
}

#[tauri::command]
fn run_cursor_intent(app: tauri::AppHandle, goal: String) -> Result<String, String> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("Tell HII what you want to happen.".to_string());
    }
    if goal.len() > 8_000 {
        return Err("Keep the intent under 8,000 characters.".to_string());
    }

    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not available".to_string())?;
    let home = PathBuf::from(home);
    let hii = home.join("bin").join("hii");
    if !hii.is_file() {
        return Err(format!("HII launcher is missing at {}", hii.display()));
    }
    let runs = runtime_root()?.join("runs").join("cursor-bar");
    create_dir_all(&runs).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let log_path = runs.join(format!("{stamp}.log"));
    let log = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let error_log = log.try_clone().map_err(|error| error.to_string())?;
    Command::new(hii)
        .arg("run")
        .arg("--cwd")
        .arg(&home)
        .arg(goal)
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn()
        .map_err(|error| error.to_string())?;
    let _ = set_notch_expanded(app.clone(), false);
    Ok(log_path.display().to_string())
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
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|err| err.to_string())
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
        Err(format!(
            "HII resources are missing at {}",
            resource_dir.display()
        ))
    }
}

fn spawn_hii_server(app: &tauri::App, port: u16) -> Result<Child, String> {
    let resource_dir = resource_root(app)?;
    let app_dir = resource_dir.join("hii-app");
    let node = app_dir.join("bin").join("node");
    let server_dir = app_dir.join("server");
    let entry = server_dir.join("server.mjs");
    if !node.is_file() || !entry.is_file() {
        return Err(format!(
            "HII portable resources are incomplete at {}",
            app_dir.display()
        ));
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
        .env("ORIGIN", format!("http://127.0.0.1:{port}"))
        .env("BODY_SIZE_LIMIT", "251M")
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

fn focus_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "HII workspace window is unavailable.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    if window.is_minimized().map_err(|error| error.to_string())? {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.set_focus().map_err(|error| error.to_string())
}

fn emit_workspace_command(app: &tauri::AppHandle, event: &str) {
    if let Err(error) = focus_workspace(app).and_then(|_| {
        app.get_webview_window("main")
            .ok_or_else(|| "HII workspace window is unavailable.".to_string())?
            .emit(event, ())
            .map_err(|error| error.to_string())
    }) {
        eprintln!("HII menu command {event} failed: {error}");
    }
}

fn hii_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let focus = MenuItem::with_id(
        app,
        MENU_FOCUS_WORKSPACE,
        "Open or Focus HII Workspace",
        true,
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let palette = MenuItem::with_id(
        app,
        MENU_COMMAND_PALETTE,
        "Command Palette",
        true,
        Some("CmdOrCtrl+K"),
    )?;
    let browser = MenuItem::with_id(
        app,
        MENU_OPEN_BROWSER,
        "New HII Browser Object",
        true,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    let fit = MenuItem::with_id(
        app,
        MENU_FIT_ALL,
        "Fit All Canvas Objects",
        true,
        Some("CmdOrCtrl+Shift+1"),
    )?;
    let refresh = MenuItem::with_id(
        app,
        MENU_REFRESH_SPACE,
        "Refresh System Space",
        true,
        None::<&str>,
    )?;
    let develop = MenuItem::with_id(
        app,
        MENU_DEVELOP_HII,
        "Develop HII in Canvas…",
        true,
        None::<&str>,
    )?;
    let commands = Submenu::with_id_and_items(
        app,
        "hii.commands",
        "HII",
        true,
        &[
            &focus,
            &palette,
            &browser,
            &fit,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &develop,
        ],
    )?;
    menu.insert(&commands, 1)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(HiiServer(Mutex::new(ServerState {
            child: None,
            url: String::new(),
        })))
        .menu(hii_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_FOCUS_WORKSPACE => {
                if let Err(error) = focus_workspace(app) {
                    eprintln!("HII could not focus the workspace: {error}");
                }
            }
            MENU_COMMAND_PALETTE => emit_workspace_command(app, "hii://command-palette"),
            MENU_OPEN_BROWSER => emit_workspace_command(app, "hii://open-browser"),
            MENU_FIT_ALL => emit_workspace_command(app, "hii://fit-all"),
            MENU_REFRESH_SPACE => emit_workspace_command(app, "hii://space-refresh"),
            MENU_DEVELOP_HII => emit_workspace_command(app, "hii://develop-hii"),
            _ => {}
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, ShortcutState,
                };

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            #[cfg(target_os = "macos")]
                            let matches =
                                shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::Space);
                            #[cfg(not(target_os = "macos"))]
                            let matches = shortcut
                                .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space);
                            if event.state != ShortcutState::Pressed || !matches {
                                return;
                            }
                            if let Err(error) = show_cursor_bar(app) {
                                eprintln!("HII could not show the cursor bar: {error}");
                            }
                        })
                        .build(),
                )?;
                #[cfg(target_os = "macos")]
                let shortcut = "super+shift+space";
                #[cfg(not(target_os = "macos"))]
                let shortcut = "ctrl+shift+space";
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    eprintln!("HII could not register {shortcut}: {error}");
                }
            }

            #[cfg(dev)]
            let (port, child) = if hii_is_reachable(DEFAULT_HII_PORT) {
                (DEFAULT_HII_PORT, None)
            } else {
                let port = available_port()?;
                (port, Some(spawn_hii_server(app, port)?))
            };
            #[cfg(not(dev))]
            let (port, child) = {
                let port = available_port()?;
                (port, Some(spawn_hii_server(app, port)?))
            };
            let hii_url = format!("http://127.0.0.1:{port}");
            *app.state::<HiiServer>()
                .0
                .lock()
                .map_err(|err| err.to_string())? = ServerState {
                child,
                url: hii_url.clone(),
            };
            if let Err(error) = ensure_cursor_bar(app.handle(), &hii_url) {
                eprintln!("HII could not prepare the cursor bar: {error}");
            }
            if let Err(error) = set_notch_expanded(app.handle().clone(), false) {
                eprintln!("HII could not position Notch: {error}");
            }

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
            if window.label() == "cursor-bar" && matches!(event, WindowEvent::Focused(false)) {
                let _ = set_notch_expanded(window.app_handle().clone(), false);
            }
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                stop_hii_server(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_surface,
            browser::browser_navigate,
            hide_cursor_bar,
            set_notch_expanded,
            open_hii_mode,
            run_cursor_intent
        ])
        .build(tauri::generate_context!())
        .expect("error while building HII desktop interface");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_hii_server(app_handle);
        }
    });
}
