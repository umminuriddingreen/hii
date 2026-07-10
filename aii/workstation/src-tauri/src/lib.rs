mod browser;
mod commands;
mod hii;
mod metrics;
mod models;
mod terminal;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(terminal::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_machines,
            commands::get_projects,
            commands::get_agent_tasks,
            commands::get_agent_task,
            commands::create_agent_task,
            commands::stop_agent_task,
            commands::restart_agent_task,
            commands::get_machine_metrics,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            browser::browser_navigate,
            browser::browser_current_url,
            hii::hii_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
