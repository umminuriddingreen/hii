//! Live local machine metrics via `sysinfo`.
//! TODO(phase-4): remote machine metrics over SSH.

use sysinfo::{Disks, System};

pub struct LocalSnapshot {
    pub hostname: String,
    pub cpu_percent: f32,
    pub ram_percent: f32,
    pub disk_percent: f32,
    pub process_count: u32,
    pub uptime_seconds: u64,
}

pub fn local_snapshot() -> LocalSnapshot {
    let mut sys = System::new_all();
    // CPU usage needs two samples spaced by the minimum update interval.
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_cpu_usage();

    let ram_percent = if sys.total_memory() > 0 {
        (sys.used_memory() as f64 / sys.total_memory() as f64 * 100.0) as f32
    } else {
        0.0
    };

    let disks = Disks::new_with_refreshed_list();
    let disk_percent = disks
        .iter()
        .find(|d| d.mount_point() == std::path::Path::new("/"))
        .or_else(|| disks.iter().next())
        .map(|d| {
            let total = d.total_space();
            if total == 0 {
                0.0
            } else {
                ((total - d.available_space()) as f64 / total as f64 * 100.0) as f32
            }
        })
        .unwrap_or(0.0);

    LocalSnapshot {
        hostname: System::host_name().unwrap_or_else(|| "local".into()),
        cpu_percent: sys.global_cpu_usage(),
        ram_percent,
        disk_percent,
        process_count: sys.processes().len() as u32,
        uptime_seconds: System::uptime(),
    }
}
