mod acp;
mod agent;
mod agents;
mod board;
mod config;
mod context;
mod contract;
mod conversation;
mod hii_tools;
mod keyboard;
mod legacy;
mod mcp;
mod ollama;
mod receipt;
#[cfg(feature = "preview")]
mod schedule;
mod skills;
#[cfg(feature = "preview")]
mod system_monitor;
mod tools;
mod tui;

use agent::RunOptions;
use clap::{Parser, Subcommand};
use config::{AppPaths, DEFAULT_MAX_STEPS, DEFAULT_MODEL, DEFAULT_REVIEW_MODEL};
use conversation::Conversation;
use ollama::Ollama;
use receipt::{find_receipt, Receipt};
use std::{
    env, fs,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::{Command, ExitCode},
    time::Instant,
};

#[derive(Parser, Debug)]
#[command(
    name = "hii",
    version,
    about = "Fast, local-first workspace agent",
    long_about = "HII turns a goal into bounded local work, verification, and an inspectable receipt.\n\nExamples:\n  hii \"fix the failing tests\"\n  hii run --review \"ship the smallest verified patch\"\n  hii proof"
)]
struct Cli {
    #[arg(
        long,
        global = true,
        value_name = "PATH",
        help = "Bound the agent to this workspace"
    )]
    cwd: Option<PathBuf>,

    #[arg(
        long,
        global = true,
        value_name = "MODEL",
        help = "Ollama model for the work loop"
    )]
    model: Option<String>,

    #[arg(
        long,
        global = true,
        default_value_t = DEFAULT_MAX_STEPS,
        help = "Optional tool-step ceiling; 0 means unlimited"
    )]
    max_steps: usize,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    #[command(alias = "agent", about = "Complete a goal inside a bounded workspace")]
    Run {
        #[arg(required = true, trailing_var_arg = true)]
        goal: Vec<String>,
        #[arg(
            long,
            help = "Ask the stronger local model to review the final receipt"
        )]
        review: bool,
        #[arg(long, default_value = DEFAULT_REVIEW_MODEL)]
        review_model: String,
        #[arg(
            long,
            help = "Inspect and reason without writes or non-verification shell actions"
        )]
        dry_run: bool,
        #[arg(long, help = "Show internal run, model, tool, and receipt details")]
        verbose: bool,
        #[arg(
            long,
            help = "Autonomous: no approval prompts, all tools allowed (workspace/secret guards still apply)"
        )]
        yolo: bool,
        #[arg(
            long,
            value_name = "LEVEL",
            help = "Authority envelope: read-only | workspace | external-preview | external-commit"
        )]
        authority: Option<String>,
        #[arg(
            long,
            value_name = "CRITERIA",
            help = "Operator-defined acceptance criterion recorded in the work contract"
        )]
        done_when: Option<String>,
        #[arg(
            long,
            value_name = "COMMAND",
            help = "Deterministic local acceptance check; repeat for multiple checks"
        )]
        verify: Vec<String>,
        #[arg(
            long,
            help = "Do not preload workspace instructions, Git state, or prior HII receipts"
        )]
        no_context: bool,
    },
    #[command(about = "Show the local workspace-agent state")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Check Rust CLI, workspace, Git, and Ollama readiness")]
    Doctor,
    #[command(about = "List locally installed Ollama models")]
    Models,
    #[command(about = "Show local, Codex, and Claude account access")]
    Providers,
    #[command(about = "Connect an existing Codex or Claude plan")]
    Login {
        #[arg(value_name = "PROVIDER", help = "codex | claude")]
        provider: String,
    },
    #[command(
        alias = "receipt",
        about = "Inspect the latest or selected run receipt"
    )]
    Proof {
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Local kanban/todo board")]
    Board {
        #[command(subcommand)]
        action: Option<BoardCommand>,
    },
    #[cfg(feature = "preview")]
    #[command(hide = true)]
    Schedule { action: String },
    #[command(
        name = "tools-manifest",
        about = "Print the agent tool capability manifest (ACP/MCP boundary) as JSON"
    )]
    ToolsManifest,
    #[command(
        name = "mcp-serve",
        about = "Serve the tool surface as an MCP server over stdio (JSON-RPC 2.0, line-delimited)"
    )]
    McpServe {
        #[arg(
            long,
            value_name = "LEVEL",
            help = "Authority envelope for tools/call: read-only | workspace | external-preview | external-commit | yolo"
        )]
        authority: Option<String>,
    },
    #[command(
        name = "acp-serve",
        about = "Serve the ACP northbound handshake over stdio (JSON-RPC 2.0, minimal stub)"
    )]
    AcpServe {
        #[arg(
            long,
            value_name = "LEVEL",
            help = "Authority envelope for the session"
        )]
        authority: Option<String>,
    },
    #[command(hide = true)]
    Legacy {
        #[arg(trailing_var_arg = true)]
        args: Vec<String>,
    },
}

#[derive(Subcommand, Debug)]
enum BoardCommand {
    #[command(alias = "show", about = "List open tasks")]
    List {
        #[arg(long)]
        done: bool,
        #[arg(long)]
        all: bool,
    },
    #[command(about = "Add a new task")]
    Add {
        #[arg(required = true, num_args = 1..)]
        title: Vec<String>,
        #[arg(long)]
        lane: Option<String>,
        #[arg(long)]
        priority: Option<String>,
        #[arg(long)]
        owner: Option<String>,
        #[arg(long)]
        coordinate: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[arg(long)]
        tags: Option<String>,
    },
    #[command(about = "Move a task to a different lane")]
    Move { id: String, lane: String },
    #[command(about = "Mark a task done")]
    Done { id: String },
    #[command(about = "Edit a task's fields")]
    Edit {
        id: String,
        #[arg(long)]
        priority: Option<String>,
        #[arg(long)]
        owner: Option<String>,
        #[arg(long)]
        coordinate: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[arg(long)]
        tags: Option<String>,
    },
    #[command(about = "Merge duplicate tasks")]
    Dedupe {
        #[arg(long = "dry-run")]
        dry_run: bool,
    },
}

fn main() -> ExitCode {
    let paths = match AppPaths::discover() {
        Ok(paths) => paths,
        Err(error) => return fail(error),
    };
    let raw: Vec<String> = env::args().collect();
    if let Some(result) = delegate_legacy(&paths.repo, &raw[1..]) {
        return match result {
            Ok(code) => ExitCode::from(code as u8),
            Err(error) => fail(error),
        };
    }
    let normalized = normalize_goal_args(raw);
    let cli = Cli::parse_from(normalized);
    match execute(cli, paths) {
        Ok(code) => code,
        Err(error) => fail(error),
    }
}

fn execute(cli: Cli, paths: AppPaths) -> Result<ExitCode, String> {
    match cli.command {
        Some(Commands::Run {
            goal,
            review,
            review_model,
            dry_run,
            verbose,
            yolo,
            authority,
            done_when,
            verify,
            no_context,
        }) => {
            let workspace = cli
                .cwd
                .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
            let authority = resolve_authority(yolo, authority.as_deref())?;
            let receipt = agent::run(
                &paths,
                RunOptions {
                    goal: goal.join(" "),
                    workspace,
                    model: cli.model,
                    review,
                    review_model: Some(review_model),
                    max_steps: cli.max_steps,
                    dry_run,
                    verbose,
                    authority,
                    done_when,
                    verify,
                    use_context: !no_context,
                },
            )?;
            Ok(if receipt.status == "completed" {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(2)
            })
        }
        Some(Commands::Status { json }) => {
            status(&paths, cli.cwd, json)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Doctor) => {
            let ok = doctor(&paths, cli.cwd)?;
            Ok(if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        Some(Commands::Models) => {
            let ollama = Ollama::new(AppPaths::ollama_url());
            for model in ollama.models()? {
                let role = if model == DEFAULT_MODEL {
                    "default"
                } else if model == DEFAULT_REVIEW_MODEL {
                    "review"
                } else {
                    "available"
                };
                println!("{model:<26} {role}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Providers) => {
            println!("{}", agents::AgentManager::new(&paths).providers()?);
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Login { provider }) => {
            println!("{}", agents::AgentManager::new(&paths).login(&provider)?);
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Proof { id, json }) => {
            proof(&paths, id.as_deref(), json)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Board { action }) => board_command(&paths, cli.cwd, action),
        Some(Commands::ToolsManifest) => {
            println!("{}", acp::render());
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::McpServe { authority }) => {
            let workspace = cli
                .cwd
                .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
            let authority = resolve_authority(false, authority.as_deref())?;
            mcp::serve(&paths, &workspace, authority)
        }
        Some(Commands::AcpServe { authority }) => {
            let authority = resolve_authority(false, authority.as_deref())?;
            acp::serve(&paths, authority)
        }
        #[cfg(feature = "preview")]
        Some(Commands::Schedule { action }) => {
            if action != "tick" {
                return Err("usage: hii schedule tick".into());
            }
            println!("{}", schedule::ScheduleService::new(&paths)?.tick()?);
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Legacy { args }) => {
            let code = legacy::run(&paths.repo, &args)?;
            Ok(ExitCode::from(code as u8))
        }
        None => {
            if io::stdin().is_terminal() && io::stdout().is_terminal() {
                repl(cli, paths)
            } else {
                status(&paths, cli.cwd, false)?;
                Ok(ExitCode::SUCCESS)
            }
        }
    }
}

fn repl(cli: Cli, paths: AppPaths) -> Result<ExitCode, String> {
    let workspace = cli
        .cwd
        .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
    let mut conversation = Conversation::new(paths, workspace, cli.model, cli.max_steps)?;
    conversation.welcome();
    // A line queued with Tab is carried forward and prepended to the next Submit.
    let mut queued: Option<String> = None;
    let interactive = keyboard::is_interactive();
    loop {
        let active_queue = conversation.take_queued();
        let goal = if let Some(pending) = active_queue {
            tui::system("Running queued follow-up.");
            pending
        } else if interactive {
            // Raw-mode keyboard model: Enter=submit, Tab=queue, Esc/Ctrl+B/Ctrl+T
            // are surfaced as events (interrupt/background/task-view meaning applies
            // during a run; at the idle prompt they are informational).
            match keyboard::read_event().map_err(|error| error.to_string())? {
                keyboard::InputEvent::Submit(line) => match queued.take() {
                    Some(pending) if line.trim().is_empty() => pending,
                    Some(pending) => format!("{pending}\n{line}"),
                    None => line,
                },
                keyboard::InputEvent::Queue(line) => {
                    if !line.trim().is_empty() {
                        queued = Some(line);
                        tui::queued();
                    }
                    continue;
                }
                keyboard::InputEvent::TaskView => {
                    tui::system(&conversation.status());
                    continue;
                }
                keyboard::InputEvent::Interrupt => break,
                keyboard::InputEvent::Background => {
                    tui::idle_background();
                    continue;
                }
            }
        } else {
            print!("hii › ");
            io::stdout().flush().map_err(|error| error.to_string())?;
            match keyboard::read_line_fallback().map_err(|error| error.to_string())? {
                Some(keyboard::InputEvent::Submit(line)) => line,
                _ => break,
            }
        };
        let goal = goal.trim();
        if matches!(goal, ":q" | ":quit" | "exit" | "/exit" | "/quit" | "/q") {
            break;
        }
        if goal.is_empty() {
            continue;
        }
        // `!<command>` runs a shell command directly (interaction grammar).
        if let Some(command) = goal.strip_prefix('!') {
            let output = conversation.shell_interactive(command.trim());
            if output != "ok" {
                tui::system(&output);
            }
            continue;
        }
        let mut show_activity = false;
        let result = match parse_slash_command(goal) {
            Some(SlashCommand::Help) => Ok(slash_help().to_string()),
            Some(SlashCommand::Compact) => conversation.compact(),
            Some(SlashCommand::Clear) => conversation.clear(),
            Some(SlashCommand::Status) => Ok(conversation.status()),
            Some(SlashCommand::Usage) => Ok(conversation.usage()),
            Some(SlashCommand::Thinking(mode)) => conversation.thinking(mode.as_deref()),
            Some(SlashCommand::Model(model)) => conversation.model(model.as_deref()),
            Some(SlashCommand::Proof(id)) => conversation.proof(id.as_deref()),
            Some(SlashCommand::Skills) => conversation.skills(),
            Some(SlashCommand::Agents) => agents::AgentManager::new(conversation.paths()).list(),
            Some(SlashCommand::Providers) => {
                agents::AgentManager::new(conversation.paths()).providers()
            }
            Some(SlashCommand::Login(provider)) => {
                agents::AgentManager::new(conversation.paths()).login(&provider)
            }
            Some(SlashCommand::Codex(task)) => {
                agents::AgentManager::new(conversation.paths()).codex(&task)
            }
            Some(SlashCommand::Undo) => conversation.undo(),
            Some(SlashCommand::Fork) => conversation.fork(),
            Some(SlashCommand::Teach(name)) => conversation.teach(&name),
            Some(SlashCommand::Claude(task)) => {
                agents::AgentManager::new(conversation.paths()).claude(&task)
            }
            Some(SlashCommand::Agent { id, action }) => {
                agents::AgentManager::new(conversation.paths()).operate(&id, &action)
            }
            #[cfg(feature = "preview")]
            Some(SlashCommand::Resources) => {
                system_monitor::snapshot(conversation.paths(), conversation.workspace())
            }
            #[cfg(feature = "preview")]
            Some(SlashCommand::Top) => system_monitor::launch_btop(),
            #[cfg(feature = "preview")]
            Some(SlashCommand::Schedule { cron, task }) => {
                schedule::ScheduleService::new(conversation.paths())?.add(&cron, &task)
            }
            #[cfg(feature = "preview")]
            Some(SlashCommand::Schedules) => {
                schedule::ScheduleService::new(conversation.paths())?.list()
            }
            #[cfg(feature = "preview")]
            Some(SlashCommand::Calendar) => {
                schedule::ScheduleService::new(conversation.paths())?.calendar_list(7)
            }
            #[cfg(feature = "preview")]
            Some(SlashCommand::CalendarAdd { date, time, title }) => {
                schedule::ScheduleService::new(conversation.paths())?.calendar_add(
                    &date,
                    time.as_deref(),
                    &title,
                )
            }
            #[cfg(feature = "preview")]
            Some(SlashCommand::SyncCalendar) => {
                schedule::ScheduleService::new(conversation.paths())?.sync_calendar()
            }
            Some(SlashCommand::Unknown(command)) => {
                Ok(format!("Unknown command: {command}\n\n{}", slash_help()))
            }
            None => {
                show_activity = true;
                conversation.reply(goal)
            }
        };
        match result {
            Ok(reply) => {
                let activity = show_activity
                    .then(|| conversation.activity_footer())
                    .flatten();
                if show_activity && io::stdout().is_terminal() {
                    if let Some(activity) = activity.as_deref() {
                        tui::activity(activity);
                    }
                } else {
                    tui::reply(&reply, activity.as_deref());
                }
            }
            Err(error) => tui::error(&error),
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[derive(Debug, PartialEq)]
enum SlashCommand {
    Help,
    Compact,
    Clear,
    Status,
    Usage,
    Thinking(Option<String>),
    Model(Option<String>),
    Proof(Option<String>),
    Skills,
    Agents,
    Providers,
    Login(String),
    Codex(String),
    Claude(String),
    Undo,
    Fork,
    Teach(String),
    Agent {
        id: String,
        action: String,
    },
    #[cfg(feature = "preview")]
    Resources,
    #[cfg(feature = "preview")]
    Top,
    #[cfg(feature = "preview")]
    Schedule {
        cron: String,
        task: String,
    },
    #[cfg(feature = "preview")]
    Schedules,
    #[cfg(feature = "preview")]
    Calendar,
    #[cfg(feature = "preview")]
    CalendarAdd {
        date: String,
        time: Option<String>,
        title: String,
    },
    #[cfg(feature = "preview")]
    SyncCalendar,
    Unknown(String),
}

fn parse_slash_command(input: &str) -> Option<SlashCommand> {
    let input = input.trim();
    if !input.starts_with('/') {
        return None;
    }
    let (command, rest) = input
        .split_once(char::is_whitespace)
        .map(|(a, b)| (a, b.trim()))
        .unwrap_or((input, ""));
    let argument = (!rest.is_empty()).then(|| rest.to_string());
    Some(match command {
        "/help" if argument.is_none() => SlashCommand::Help,
        "/compact" if argument.is_none() => SlashCommand::Compact,
        "/clear" if argument.is_none() => SlashCommand::Clear,
        "/status" if argument.is_none() => SlashCommand::Status,
        "/usage" if argument.is_none() => SlashCommand::Usage,
        "/thinking" => SlashCommand::Thinking(argument),
        "/model" => SlashCommand::Model(argument),
        "/models" if rest.is_empty() => SlashCommand::Model(None),
        "/proof" => SlashCommand::Proof(argument),
        "/skills" if rest.is_empty() => SlashCommand::Skills,
        "/agents" if rest.is_empty() => SlashCommand::Agents,
        "/providers" if rest.is_empty() => SlashCommand::Providers,
        "/login" => SlashCommand::Login(rest.to_ascii_lowercase()),
        "/codex" => SlashCommand::Codex(rest.to_string()),
        "/claude" => SlashCommand::Claude(rest.to_string()),
        "/undo" if argument.is_none() => SlashCommand::Undo,
        "/fork" if argument.is_none() => SlashCommand::Fork,
        "/teach" => SlashCommand::Teach(rest.to_string()),
        "/agent" => {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            if parts.len() == 2 {
                SlashCommand::Agent {
                    id: parts[0].into(),
                    action: parts[1].into(),
                }
            } else {
                SlashCommand::Unknown(input.into())
            }
        }
        #[cfg(feature = "preview")]
        "/resources" if rest.is_empty() => SlashCommand::Resources,
        #[cfg(feature = "preview")]
        "/top" if rest.is_empty() => SlashCommand::Top,
        #[cfg(feature = "preview")]
        "/schedule" => match rest.split_once("::") {
            Some((cron, task)) if !cron.trim().is_empty() && !task.trim().is_empty() => {
                SlashCommand::Schedule {
                    cron: cron.trim().into(),
                    task: task.trim().into(),
                }
            }
            _ => SlashCommand::Unknown(input.into()),
        },
        #[cfg(feature = "preview")]
        "/schedules" if rest.is_empty() => SlashCommand::Schedules,
        #[cfg(feature = "preview")]
        "/calendar" if rest.is_empty() => SlashCommand::Calendar,
        #[cfg(feature = "preview")]
        "/calendar" if rest.starts_with("add ") => {
            parse_calendar_add(rest).unwrap_or_else(|| SlashCommand::Unknown(input.into()))
        }
        #[cfg(feature = "preview")]
        "/sync" if rest == "calendar" => SlashCommand::SyncCalendar,
        _ => SlashCommand::Unknown(input.to_string()),
    })
}

fn slash_help() -> &'static str {
    if cfg!(feature = "preview") {
        "/help                         show commands\n/providers                    show local, Codex, and Claude access\n/login codex|claude           connect an existing provider plan\n/compact                      summarize and shrink this conversation\n/clear                        start with fresh context\n/status                       show session, workspace, model, and usage\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw model stream\n/model [name]                 list or switch local models\n/proof [run-id]               inspect execution proof\n/skills                       show automatically learned skill drafts\n/agents                       show HII-managed and observed agents\n/codex <task>                 use authenticated Codex CLI\n/claude <task>                use authenticated Claude CLI\n/agent <id> status|logs|stop  manage an agent by id\n/resources                    quick CPU, memory, storage, and Ollama view\n/top                          open the embedded btop resource monitor\n/schedule <cron> :: <task>    create a local recurring HII task\n/schedules                    list HII schedules\n/calendar                     show the next 7 days\n/calendar add DATE [TIME] :: TITLE\n/sync calendar                sync next HII runs to Apple Calendar\n/exit                         leave HII\n\nWhile running: type + Enter steers · type + Tab queues · Esc stops"
    } else {
        "/help                         show commands\n/providers                    show local, Codex, and Claude access\n/login codex|claude           connect an existing provider plan\n/compact                      summarize and shrink this conversation\n/clear                        start with fresh context\n/status                       show session, workspace, model, and usage\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw model stream\n/model [name]                 list or switch local models\n/proof [run-id]               inspect execution proof\n/skills                       show automatically learned skill drafts\n/agents                       show HII-managed and observed agents\n/codex <task>                 use authenticated Codex CLI\n/claude <task>                use authenticated Claude CLI\n/agent <id> status|logs|stop  manage an agent by id\n/undo                         drop the last exchange to steer away\n/fork                         snapshot this session to a resumable fork\n/teach <name>                 graduate this session into a reusable skill\n!<command>                    run a shell command directly\n/exit                         leave HII\n\nWhile running: type + Enter steers · type + Tab queues · Esc stops"
    }
}

#[cfg(feature = "preview")]
fn parse_calendar_add(rest: &str) -> Option<SlashCommand> {
    let (when, title) = rest.strip_prefix("add ")?.split_once("::")?;
    let mut fields = when.split_whitespace();
    let date = fields.next()?.to_string();
    let time = fields.next().map(str::to_string);
    if fields.next().is_some() || title.trim().is_empty() {
        return None;
    }
    Some(SlashCommand::CalendarAdd {
        date,
        time,
        title: title.trim().into(),
    })
}

fn status(paths: &AppPaths, cwd: Option<PathBuf>, json: bool) -> Result<(), String> {
    let started = Instant::now();
    let workspace = cwd.unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
    let branch = command_text("git", &["branch", "--show-current"], &workspace)
        .unwrap_or_else(|| "not-git".into());
    let dirty = command_text("git", &["status", "--porcelain"], &workspace)
        .map(|output| output.lines().count())
        .unwrap_or(0);
    let ollama = Ollama::new(AppPaths::ollama_url());
    let models = ollama.models().unwrap_or_default();
    let latest = fs::read_to_string(paths.runtime.join("runs/cli/latest")).unwrap_or_default();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "name": "HII",
                "engine": "rust",
                "workspace": workspace,
                "branch": branch.trim(),
                "changes": dirty,
                "ollama": !models.is_empty(),
                "models": models,
                "defaultModel": DEFAULT_MODEL,
                "reviewModel": DEFAULT_REVIEW_MODEL,
                "latestRun": latest.trim(),
                "runtime": paths.runtime,
                "elapsedMs": started.elapsed().as_millis()
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        println!("HII  ·  Rust workspace agent");
        println!("workspace  {}", workspace.display());
        println!("git        {}  ·  {} change(s)", branch.trim(), dirty);
        println!(
            "ollama     {}  ·  {} model(s)",
            if models.is_empty() {
                "offline"
            } else {
                "ready"
            },
            models.len()
        );
        println!(
            "agent      {}  ·  {}",
            DEFAULT_MODEL,
            if DEFAULT_MAX_STEPS == 0 {
                "unlimited"
            } else {
                "operator step ceiling"
            }
        );
        if !latest.trim().is_empty() {
            println!("proof      hii proof {}", latest.trim());
        }
        println!("start      hii \"what should be true\"");
    }
    Ok(())
}

fn doctor(paths: &AppPaths, cwd: Option<PathBuf>) -> Result<bool, String> {
    let workspace = cwd.unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
    let checks = [
        (
            "Rust binary",
            true,
            env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
        ),
        (
            "Workspace",
            workspace.is_dir(),
            workspace.display().to_string(),
        ),
        (
            "HII runtime",
            paths.runtime.is_dir(),
            paths.runtime.display().to_string(),
        ),
        (
            "Git",
            command_text("git", &["--version"], &workspace).is_some(),
            "git --version".into(),
        ),
        (
            // Search backend is never fatal: absent rg falls back to a native walk.
            "Search",
            true,
            if command_text("rg", &["--version"], &workspace).is_some() {
                "ripgrep".into()
            } else {
                "native (rg not found)".into()
            },
        ),
        (
            "Shell",
            true,
            std::env::var("HII_SHELL")
                .ok()
                .or_else(|| std::env::var("SHELL").ok())
                .unwrap_or_else(|| {
                    if cfg!(windows) {
                        "powershell"
                    } else {
                        "/bin/sh"
                    }
                    .to_string()
                }),
        ),
        (
            "Model endpoint",
            true,
            format!(
                "{} ({:?})",
                AppPaths::model_url(),
                config::ModelProvider::discover(&AppPaths::model_url())
            ),
        ),
    ];
    let mut ok = true;
    for (name, passed, detail) in checks {
        ok &= passed;
        println!("{}  {name:<14} {detail}", if passed { "ok" } else { "!!" });
    }
    let ollama = Ollama::new(AppPaths::ollama_url());
    match ollama.models() {
        Ok(models) => {
            let default = models.iter().any(|model| model == DEFAULT_MODEL);
            let review = models.iter().any(|model| model == DEFAULT_REVIEW_MODEL);
            ok &= default;
            println!(
                "{}  {:<14} {}",
                if default { "ok" } else { "!!" },
                "Ollama agent",
                DEFAULT_MODEL
            );
            println!(
                "{}  {:<14} {}",
                if review { "ok" } else { "--" },
                "Ollama review",
                DEFAULT_REVIEW_MODEL
            );
        }
        Err(error) => {
            ok = false;
            println!("!!  {:<14} {error}", "Ollama");
        }
    }
    println!("\n{}", if ok { "ready" } else { "not ready" });
    Ok(ok)
}

fn proof(paths: &AppPaths, id: Option<&str>, json: bool) -> Result<(), String> {
    let path = find_receipt(&paths.runtime, id)?;
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if json {
        println!("{raw}");
        return Ok(());
    }
    let receipt: Receipt = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    println!("HII proof {}", receipt.id);
    println!("status     {}", receipt.status);
    println!("goal       {}", receipt.goal);
    println!("workspace  {}", receipt.workspace);
    println!("model      {}", receipt.model);
    println!("steps      {}", receipt.steps);
    println!("summary    {}", receipt.summary);
    if let Some(done_when) = receipt.done_when.as_deref() {
        println!("done when  {done_when}");
    }
    println!("context    {} source(s)", receipt.context_sources.len());
    for source in &receipt.context_sources {
        println!("  <-  {source}");
    }
    println!(
        "baseline   {} pre-existing change(s)",
        receipt.preexisting_changes.len()
    );
    println!("verified   {} check(s)", receipt.verification.len());
    for check in &receipt.verification {
        println!(
            "  {}  {}",
            if check.ok { "ok" } else { "!!" },
            check.command
        );
    }
    println!("risk       {}", receipt.risk);
    println!("receipt    {}", path.display());
    Ok(())
}

fn board_command(
    paths: &AppPaths,
    cwd: Option<PathBuf>,
    action: Option<BoardCommand>,
) -> Result<ExitCode, String> {
    let root = cwd.unwrap_or(paths.repo.clone());
    let store = board::Board::open(&paths.runtime);
    match action.unwrap_or(BoardCommand::List {
        done: false,
        all: false,
    }) {
        BoardCommand::List { done, all } => {
            let include_done = done || all;
            let tasks = store.tasks(include_done)?;
            board::print_board(store.store_path(), &tasks, include_done);
            Ok(ExitCode::SUCCESS)
        }
        BoardCommand::Add {
            title,
            lane,
            priority,
            owner,
            coordinate,
            notes,
            tags,
        } => {
            let task = store.add(
                &root,
                board::AddOptions {
                    title: title.join(" "),
                    lane,
                    priority,
                    owner,
                    coordinate,
                    notes,
                    tags,
                },
            )?;
            println!("added {}  {}", &task.id[..8.min(task.id.len())], task.title);
            println!("lane: {}  priority: {}", task.lane, task.priority);
            println!("store: {}", store.store_path().display());
            Ok(ExitCode::SUCCESS)
        }
        BoardCommand::Move { id, lane } => {
            let task = store.update(
                &id,
                board::EditPatch {
                    lane: Some(lane),
                    ..Default::default()
                },
            )?;
            println!(
                "moved {} -> {}",
                &task.id[..8.min(task.id.len())],
                task.lane
            );
            println!("{}", task.title);
            Ok(ExitCode::SUCCESS)
        }
        BoardCommand::Done { id } => {
            let task = store.update(
                &id,
                board::EditPatch {
                    lane: Some("done".to_string()),
                    ..Default::default()
                },
            )?;
            println!("done {}", &task.id[..8.min(task.id.len())]);
            println!("{}", task.title);
            Ok(ExitCode::SUCCESS)
        }
        BoardCommand::Edit {
            id,
            priority,
            owner,
            coordinate,
            notes,
            tags,
        } => {
            let task = store.update(
                &id,
                board::EditPatch {
                    lane: None,
                    priority,
                    owner,
                    coordinate,
                    notes,
                    tags,
                },
            )?;
            println!(
                "updated {}  {}",
                &task.id[..8.min(task.id.len())],
                task.title
            );
            Ok(ExitCode::SUCCESS)
        }
        BoardCommand::Dedupe { dry_run } => {
            let reconciled = store.dedupe(dry_run)?;
            println!("HII board deduplication\n");
            println!(
                "mode:       {}",
                if dry_run { "dry-run" } else { "append-only" }
            );
            println!("duplicates: {}", reconciled.len());
            for (duplicate, keep) in &reconciled {
                println!(
                    "  {} -> done; keep {}  {}",
                    &duplicate.id[..8.min(duplicate.id.len())],
                    &keep.id[..8.min(keep.id.len())],
                    keep.title
                );
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn first_command(args: &[String]) -> Option<&str> {
    let mut skip_value = false;
    for arg in args {
        if skip_value {
            skip_value = false;
            continue;
        }
        if matches!(arg.as_str(), "--cwd" | "--model" | "--max-steps") {
            skip_value = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        return Some(arg);
    }
    None
}

fn delegate_legacy(repo: &std::path::Path, args: &[String]) -> Option<Result<i32, String>> {
    let command = first_command(args)?;
    legacy::is_legacy(command).then(|| legacy::run(repo, args))
}

fn is_native_command(command: &str) -> bool {
    matches!(
        command,
        "run"
            | "agent"
            | "status"
            | "doctor"
            | "models"
            | "providers"
            | "login"
            | "proof"
            | "receipt"
            | "board"
            | "legacy"
            | "help"
            | "tools-manifest"
            | "mcp-serve"
            | "acp-serve"
    ) || (cfg!(feature = "preview") && command == "schedule")
}

fn normalize_goal_args(mut args: Vec<String>) -> Vec<String> {
    let Some(command) = first_command(&args[1..]).map(str::to_string) else {
        return args;
    };
    if is_native_command(&command) {
        return args;
    }
    let insertion = args.iter().position(|arg| arg == &command).unwrap_or(1);
    args.insert(insertion, "run".into());
    args
}

fn command_text(program: &str, args: &[&str], cwd: &std::path::Path) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolve the authority envelope from flags + env. `--yolo` (or `HII_YOLO=1`)
/// wins; otherwise `--authority <level>` maps by name; default is `workspace`.
fn resolve_authority(yolo: bool, level: Option<&str>) -> Result<contract::Authority, String> {
    use contract::Authority;
    if yolo
        || matches!(
            std::env::var("HII_YOLO").ok().as_deref(),
            Some("1") | Some("true")
        )
    {
        return Ok(Authority::Yolo);
    }
    match level.map(|value| value.trim().to_ascii_lowercase()).as_deref() {
        None => Ok(Authority::Workspace),
        Some("read-only") | Some("readonly") => Ok(Authority::ReadOnly),
        Some("workspace") => Ok(Authority::Workspace),
        Some("external-preview") | Some("preview") => Ok(Authority::ExternalPreview),
        Some("external-commit") | Some("commit") => Ok(Authority::ExternalCommit),
        Some("yolo") => Ok(Authority::Yolo),
        Some(other) => Err(format!(
            "unknown authority '{other}'; use read-only | workspace | external-preview | external-commit | yolo"
        )),
    }
}

fn fail(error: impl std::fmt::Display) -> ExitCode {
    eprintln!("hii: {error}");
    ExitCode::from(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::{Path, PathBuf},
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    const FROZEN_LEGACY_FAMILIES: &[&str] = &[
        "ship", "bridge", "og", "caps", "context", "health", "task", "work", "skill", "codex",
        "daemon", "loop", "feed", "probe", "check",
    ];

    struct TempRepo(PathBuf);

    impl TempRepo {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let path = env::temp_dir().join(format!("hii-cli-parity-{}-{nonce}", process::id()));
            fs::create_dir_all(path.join("scripts")).expect("create temporary scripts directory");
            fs::write(
                path.join("scripts/hii-cli.mjs"),
                "import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('../delegations.log', import.meta.url), `${process.argv[2]}\\n`);\n",
            )
            .expect("write temporary compatibility script");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn unknown_words_become_a_goal() {
        let args = vec!["hii".into(), "fix".into(), "the".into(), "tests".into()];
        assert_eq!(
            normalize_goal_args(args),
            vec!["hii", "run", "fix", "the", "tests"]
        );
    }

    #[test]
    fn native_command_is_preserved() {
        let args = vec!["hii".into(), "status".into()];
        assert_eq!(normalize_goal_args(args.clone()), args);
    }

    #[test]
    fn cli_has_no_step_ceiling_by_default() {
        let cli = Cli::try_parse_from(["hii"]).expect("parse default CLI");
        assert_eq!(cli.max_steps, 0);
    }

    #[test]
    fn parses_conversational_controls() {
        assert_eq!(
            parse_slash_command("/model qwen3.6:35b-mlx"),
            Some(SlashCommand::Model(Some("qwen3.6:35b-mlx".into())))
        );
        assert_eq!(
            parse_slash_command("/login codex"),
            Some(SlashCommand::Login("codex".into()))
        );
        assert_eq!(
            parse_slash_command("/providers"),
            Some(SlashCommand::Providers)
        );
    }

    #[test]
    fn frozen_command_families_reach_legacy_run() {
        let repo = TempRepo::new();
        for family in FROZEN_LEGACY_FAMILIES {
            let args = vec![family.to_string(), "--help".to_string()];
            let code = delegate_legacy(repo.path(), &args)
                .unwrap_or_else(|| panic!("{family} did not select legacy delegation"))
                .unwrap_or_else(|error| panic!("{family} delegation failed: {error}"));
            assert_eq!(code, 0, "{family} compatibility command failed");
        }
        let calls = fs::read_to_string(repo.path().join("delegations.log"))
            .expect("read compatibility calls");
        assert_eq!(calls.lines().collect::<Vec<_>>(), FROZEN_LEGACY_FAMILIES);
    }

    #[test]
    fn node_cli_help_round_trip_exits_cleanly() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CLI crate should live directly beneath the repository");
        let code =
            legacy::run(repo, &["--help".to_string()]).expect("Node compatibility help should run");
        assert_eq!(code, 0);
    }

    #[cfg(not(feature = "preview"))]
    #[test]
    fn preview_commands_are_unreachable_by_default() {
        assert!(!is_native_command("schedule"));
        assert!(legacy::is_legacy("schedule"));
        for command in [
            "/resources",
            "/top",
            "/schedule 0 * * * * :: inspect",
            "/schedules",
            "/calendar",
            "/calendar add 2026-07-20 :: Review",
            "/sync calendar",
        ] {
            assert_eq!(
                parse_slash_command(command),
                Some(SlashCommand::Unknown(command.into()))
            );
        }
    }

    #[cfg(feature = "preview")]
    #[test]
    fn parses_preview_conversational_controls() {
        assert_eq!(
            parse_slash_command("/schedule */15 * * * * :: inspect build health"),
            Some(SlashCommand::Schedule {
                cron: "*/15 * * * *".into(),
                task: "inspect build health".into()
            })
        );
        assert_eq!(
            parse_slash_command("/calendar add 2026-07-20 14:30 :: Review"),
            Some(SlashCommand::CalendarAdd {
                date: "2026-07-20".into(),
                time: Some("14:30".into()),
                title: "Review".into()
            })
        );
    }
}
