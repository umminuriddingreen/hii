use serde::Serialize;
use std::{
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, Url, WindowEvent};

const CANVAS_URL: &str = "http://127.0.0.1:3042";
const DEFAULT_HII_REPO: &str = "/Users/ummi/hii";

struct CanvasServer(Mutex<Option<Child>>);

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
        surface: "canvas",
        server: CANVAS_URL,
    }
}

fn canvas_is_reachable() -> bool {
    let addr: SocketAddr = "127.0.0.1:3042".parse().expect("valid local canvas address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn spawn_canvas_server() -> Result<Child, String> {
    let repo = std::env::var("HII_REPO").unwrap_or_else(|_| DEFAULT_HII_REPO.to_string());
    Command::new("/bin/zsh")
        .arg("-lc")
        .arg("npm run start:web:tauri")
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CanvasServer(Mutex::new(None)))
        .setup(|app| {
            if !canvas_is_reachable() {
                let child = spawn_canvas_server()?;
                *app.state::<CanvasServer>().0.lock().map_err(|err| err.to_string())? = Some(child);
            }

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..40 {
                    if canvas_is_reachable() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }

                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Ok(url) = Url::parse(CANVAS_URL) {
                        let _ = window.navigate(url);
                    }
                    let _ = window.set_focus();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Ok(mut child) = window
                    .app_handle()
                    .state::<CanvasServer>()
                    .0
                    .lock()
                {
                    if let Some(mut process) = child.take() {
                        let _ = process.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![desktop_surface])
        .run(tauri::generate_context!())
        .expect("error while running HII Canvas desktop shell");
}
