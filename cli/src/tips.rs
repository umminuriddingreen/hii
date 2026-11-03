use std::sync::atomic::{AtomicUsize, Ordering};

const TIPS: &[&str] = &[
    "Left on an empty composer opens /workspace: files, runs, proof, and shell.",
    "Use !<command> to run a shell command directly in the current workspace.",
    "While HII works, Enter steers, Tab queues a message, and Esc stops the action.",
    "/goal <objective> keeps a durable objective for this session.",
    "/export saves the conversation transcript under ~/.hii/exports.",
    "/runs opens this conversation's runs and artifacts; /proof inspects evidence.",
    "/model chooses a model or browses hardware-fit options.",
];

static NEXT_TIP: AtomicUsize = AtomicUsize::new(0);

/// Return one rotating, source-backed hint without reading or writing settings.
pub fn hint() -> &'static str {
    let index = NEXT_TIP.fetch_add(1, Ordering::Relaxed) % TIPS.len();
    TIPS[index]
}

/// List the curated tips, or return the next rotating tip.
pub fn command(requested: Option<&str>) -> Result<String, String> {
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(format!("Quick tips:\n{}", TIPS.join("\n"))),
        Some("next") => Ok(hint().to_string()),
        Some(_) => Err("usage: /tips [next]".into()),
    }
}
