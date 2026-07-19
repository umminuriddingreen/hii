mod agent;
mod agents;
mod config;
mod conversation;
mod legacy;
mod ollama;
mod receipt;
mod schedule;
mod skills;
mod system_monitor;
mod tools;

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

    #[arg(long, global = true, default_value_t = DEFAULT_MAX_STEPS, help = "Maximum autonomous tool steps")]
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
    #[command(
        alias = "receipt",
        about = "Inspect the latest or selected run receipt"
    )]
    Proof {
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(hide = true)]
    Schedule { action: String },
    #[command(hide = true)]
    Legacy {
        #[arg(trailing_var_arg = true)]
        args: Vec<String>,
    },
}

fn main() -> ExitCode {
    let paths = match AppPaths::discover() {
        Ok(paths) => paths,
        Err(error) => return fail(error),
    };
    let raw: Vec<String> = env::args().collect();
    if let Some(command) = first_command(&raw[1..]) {
        if legacy::is_legacy(command) {
            return match legacy::run(&paths.repo, &raw[1..]) {
                Ok(code) => ExitCode::from(code as u8),
                Err(error) => fail(error),
            };
        }
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
        }) => {
            let workspace = cli
                .cwd
                .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
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
        Some(Commands::Proof { id, json }) => {
            proof(&paths, id.as_deref(), json)?;
            Ok(ExitCode::SUCCESS)
        }
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
    println!("HII\n");
    loop {
        print!("hii › ");
        io::stdout().flush().map_err(|error| error.to_string())?;
        let mut goal = String::new();
        if io::stdin()
            .read_line(&mut goal)
            .map_err(|error| error.to_string())?
            == 0
        {
            break;
        }
        let goal = goal.trim();
        if matches!(goal, ":q" | ":quit" | "exit" | "/exit" | "/quit" | "/q") {
            break;
        }
        if goal.is_empty() {
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
            Some(SlashCommand::Codex(task)) => {
                agents::AgentManager::new(conversation.paths()).codex(&task)
            }
            Some(SlashCommand::Claude(task)) => {
                agents::AgentManager::new(conversation.paths()).claude(&task)
            }
            Some(SlashCommand::Agent { id, action }) => {
                agents::AgentManager::new(conversation.paths()).operate(&id, &action)
            }
            Some(SlashCommand::Resources) => {
                system_monitor::snapshot(conversation.paths(), conversation.workspace())
            }
            Some(SlashCommand::Top) => system_monitor::launch_btop(),
            Some(SlashCommand::Schedule { cron, task }) => {
                schedule::ScheduleService::new(conversation.paths())?.add(&cron, &task)
            }
            Some(SlashCommand::Schedules) => {
                schedule::ScheduleService::new(conversation.paths())?.list()
            }
            Some(SlashCommand::Calendar) => {
                schedule::ScheduleService::new(conversation.paths())?.calendar_list(7)
            }
            Some(SlashCommand::CalendarAdd { date, time, title }) => {
                schedule::ScheduleService::new(conversation.paths())?.calendar_add(
                    &date,
                    time.as_deref(),
                    &title,
                )
            }
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
                println!("\n{reply}");
                if show_activity {
                    if let Some(activity) = conversation.activity_footer() {
                        println!("\x1b[2m{activity}\x1b[0m");
                    }
                }
                println!();
            }
            Err(error) => println!("\nI hit a local problem: {error}\n"),
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
    Codex(String),
    Claude(String),
    Agent {
        id: String,
        action: String,
    },
    Resources,
    Top,
    Schedule {
        cron: String,
        task: String,
    },
    Schedules,
    Calendar,
    CalendarAdd {
        date: String,
        time: Option<String>,
        title: String,
    },
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
        "/codex" => SlashCommand::Codex(rest.to_string()),
        "/claude" => SlashCommand::Claude(rest.to_string()),
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
        "/resources" if rest.is_empty() => SlashCommand::Resources,
        "/top" if rest.is_empty() => SlashCommand::Top,
        "/schedule" => match rest.split_once("::") {
            Some((cron, task)) if !cron.trim().is_empty() && !task.trim().is_empty() => {
                SlashCommand::Schedule {
                    cron: cron.trim().into(),
                    task: task.trim().into(),
                }
            }
            _ => SlashCommand::Unknown(input.into()),
        },
        "/schedules" if rest.is_empty() => SlashCommand::Schedules,
        "/calendar" if rest.is_empty() => SlashCommand::Calendar,
        "/calendar" if rest.starts_with("add ") => {
            parse_calendar_add(rest).unwrap_or_else(|| SlashCommand::Unknown(input.into()))
        }
        "/sync" if rest == "calendar" => SlashCommand::SyncCalendar,
        _ => SlashCommand::Unknown(input.to_string()),
    })
}

fn slash_help() -> &'static str {
    "/help                         show commands\n/compact                      summarize and shrink this conversation\n/clear                        start with fresh context\n/status                       show session, workspace, model, and usage\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | detailed activity\n/model [name]                 list or switch local models\n/proof [run-id]               inspect execution proof\n/skills                       show automatically learned skill drafts\n/agents                       show HII-managed and observed agents\n/codex <task>                 start a managed Codex run\n/claude <task>                start a managed Claude session\n/agent <id> status|logs|stop  manage an agent by id\n/resources                    quick CPU, memory, storage, and Ollama view\n/top                          open the embedded btop resource monitor\n/schedule <cron> :: <task>    create a local recurring HII task\n/schedules                    list HII schedules\n/calendar                     show the next 7 days\n/calendar add DATE [TIME] :: TITLE\n/sync calendar                sync next HII runs to Apple Calendar\n/exit                         leave HII"
}

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
            "agent      {}  ·  {} steps",
            DEFAULT_MODEL, DEFAULT_MAX_STEPS
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
            "ripgrep",
            command_text("rg", &["--version"], &workspace).is_some(),
            "rg --version".into(),
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

fn normalize_goal_args(mut args: Vec<String>) -> Vec<String> {
    let Some(command) = first_command(&args[1..]).map(str::to_string) else {
        return args;
    };
    let native = [
        "run", "agent", "status", "doctor", "models", "proof", "receipt", "schedule", "legacy",
        "help",
    ];
    if native.contains(&command.as_str()) {
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

fn fail(error: impl std::fmt::Display) -> ExitCode {
    eprintln!("hii: {error}");
    ExitCode::from(1)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_conversational_controls() {
        assert_eq!(
            parse_slash_command("/model qwen3.6:35b-mlx"),
            Some(SlashCommand::Model(Some("qwen3.6:35b-mlx".into())))
        );
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
