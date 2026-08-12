mod acp;
mod agent;
mod agents;
mod attachments;
mod background;
mod board;
mod budget;
mod capability_discovery;
mod completion;
mod config;
mod context;
mod contract;
mod conversation;
mod design;
mod governance;
mod hii_tools;
mod hooks;
mod keyboard;
mod keymap;
mod learning;
mod legacy;
mod mcp;
mod mcp_client;
mod ollama;
mod receipt;
mod runlog;
mod schedule;
mod skills;
#[cfg(feature = "preview")]
mod system_monitor;
mod tools;
mod tui;

use agent::{AutonomyLevel, RunOptions, RunOutput};
use budget::{Budgets, DEFAULT_WALL_CLOCK_SECS};
use clap::{Parser, Subcommand, ValueEnum};
use config::{AppPaths, DEFAULT_MAX_STEPS};
use conversation::Conversation;
use ollama::Ollama;
use receipt::{find_receipt, Receipt};
use runlog::StreamPolicy;
use std::{
    env, fs,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    process::{Command, ExitCode},
    time::{Duration, Instant},
};

#[derive(Parser, Debug)]
#[command(
    name = "hii",
    version,
    about = "Fast, local-first workspace agent",
    long_about = "HII is the local home for human intent, bounded agent work, and inspectable proof.\n\nStart here:\n  hii                          open the interactive workspace\n  hii home                     show the compact current coordinate\n  hii \"fix the failing tests\"  run a bounded goal\n  hii proof                    inspect what completed",
    after_help = legacy::help_footer()
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

    #[arg(
        long,
        global = true,
        value_name = "DURATION",
        help = "Wall-clock ceiling for a run, e.g. 90s, 15m, 1h; 0 means unlimited"
    )]
    deadline: Option<String>,

    #[arg(
        long,
        global = true,
        value_enum,
        default_value_t = SessionProfile::Local,
        help = "Session boundary: local | public-test"
    )]
    session_profile: SessionProfile,

    #[arg(
        long,
        global = true,
        help = "Disable all operator-local lifecycle hooks for this session"
    )]
    no_hooks: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
enum SessionProfile {
    #[default]
    Local,
    PublicTest,
}

#[derive(Subcommand, Debug)]
enum Commands {
    #[command(alias = "agent", about = "Complete a goal inside a bounded workspace")]
    Run {
        #[arg(required = true, num_args = 1..)]
        goal: Vec<String>,
        #[arg(
            long,
            help = "Ask the stronger local model to review the final receipt"
        )]
        review: bool,
        /// Left unset so the review model resolves per provider at run time; a
        /// fixed clap default would pin an Ollama tag onto every runtime.
        #[arg(long)]
        review_model: Option<String>,
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
            value_name = "KIND",
            help = "Declared outcome the run must produce: informational | file-artifact"
        )]
        outcome: Option<String>,
        #[arg(
            long = "require-artifact",
            value_name = "PATH",
            help = "Workspace-relative artifact the run must produce: path[:ext][xN][@sha256]; repeat for several"
        )]
        require_artifact: Vec<String>,
        #[arg(
            long,
            help = "Do not preload workspace instructions, Git state, or prior HII receipts"
        )]
        no_context: bool,
        #[arg(
            long,
            conflicts_with_all = ["jsonl", "verbose"],
            help = "Print one machine-readable final result"
        )]
        json: bool,
        #[arg(
            long,
            conflicts_with_all = ["json", "verbose"],
            help = "Stream machine-readable run events, one JSON object per line"
        )]
        jsonl: bool,
        #[arg(
            long,
            conflicts_with_all = ["json", "jsonl", "verbose"],
            help = "Write only the receipt; suppress progress and the final summary"
        )]
        quiet: bool,
        #[arg(
            long,
            help = "Show step-by-step progress even when stdout is not a terminal"
        )]
        stream: bool,
        #[arg(
            long,
            help = "Start even when a declared --verify command's program is missing"
        )]
        allow_missing_verify_deps: bool,
        #[arg(long, help = "Use the stricter native coding agent loop")]
        coding: bool,
        #[arg(
            long,
            value_enum,
            default_value_t = AutonomyArg::LocalFull,
            help = "Autonomy mode: local-full | approval"
        )]
        autonomy: AutonomyArg,
        #[arg(
            long,
            value_name = "PATH",
            help = "Write the final model message to a file inside the workspace"
        )]
        last_message: Option<PathBuf>,
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
    #[command(about = "Discover and download capability sources from trusted online indexes")]
    Discover {
        #[command(subcommand)]
        action: DiscoverCommand,
    },
    #[command(about = "Manage local recurring HII work through cron")]
    Schedule {
        #[command(subcommand)]
        action: ScheduleCommand,
    },
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
        #[arg(
            long,
            value_name = "ID",
            help = "Apply the configured per-client ACL for this caller identity"
        )]
        client_identity: Option<String>,
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
        #[arg(long = "check", value_name = "CRITERION")]
        acceptance_criteria: Vec<String>,
        #[arg(long)]
        tags: Option<String>,
    },
    #[command(about = "Move a task to a different lane")]
    Move { id: String, lane: String },
    #[command(about = "Approve a generated proposal into active work")]
    Approve {
        id: String,
        #[arg(long)]
        lane: Option<String>,
    },
    #[command(about = "Mark a task done")]
    Done { id: String },
    #[command(about = "Edit a task's fields")]
    Edit {
        id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        priority: Option<String>,
        #[arg(long)]
        owner: Option<String>,
        #[arg(long)]
        coordinate: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[arg(long = "check", value_name = "CRITERION")]
        acceptance_criteria: Vec<String>,
        #[arg(long)]
        tags: Option<String>,
    },
    #[command(about = "Merge duplicate tasks")]
    Dedupe {
        #[arg(long = "dry-run")]
        dry_run: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ScheduleCommand {
    #[command(about = "Create a recurring local HII task")]
    Add {
        #[arg(help = "Five-field cron expression, quoted as one argument")]
        cron: String,
        #[arg(required = true, num_args = 1..)]
        task: Vec<String>,
    },
    #[command(alias = "ls", about = "List recurring HII tasks")]
    List,
    #[command(about = "Pause a recurring task")]
    Pause { id: String },
    #[command(about = "Resume a recurring task")]
    Resume { id: String },
    #[command(about = "Remove a recurring task")]
    Remove { id: String },
    #[command(hide = true)]
    Tick,
}

#[derive(Subcommand, Debug)]
enum DiscoverCommand {
    #[command(about = "Search GitHub repositories above a safe star floor")]
    Github {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[arg(long, default_value_t = capability_discovery::default_min_stars())]
        min_stars: u64,
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    #[command(about = "Prepare a bounded public search query for X/Twitter capability signals")]
    X {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
    },
    #[command(about = "Prepare a bounded public web discovery query")]
    Web {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
    },
    #[command(about = "Clone a GitHub capability source after checking its star count")]
    Install {
        #[arg(value_name = "OWNER/REPO_OR_URL")]
        repo: String,
        #[arg(long, default_value_t = capability_discovery::default_min_stars())]
        min_stars: u64,
        #[arg(long, value_name = "DIR")]
        name: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
enum AutonomyArg {
    Approval,
    #[default]
    LocalFull,
}

impl From<AutonomyArg> for AutonomyLevel {
    fn from(value: AutonomyArg) -> Self {
        match value {
            AutonomyArg::Approval => AutonomyLevel::Approval,
            AutonomyArg::LocalFull => AutonomyLevel::LocalFull,
        }
    }
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
    if let Some((typed, suggestion)) = command_suggestion(&raw[1..]) {
        return fail(format!(
            "unknown command `{typed}`; did you mean `hii {suggestion}`?\nIf `{typed}` is a goal, run `hii run {typed}`."
        ));
    }
    let normalized = normalize_goal_args(raw);
    let cli = Cli::parse_from(normalized);
    match execute(cli, paths) {
        Ok(code) => code,
        Err(error) => fail(error),
    }
}

fn execute(cli: Cli, paths: AppPaths) -> Result<ExitCode, String> {
    if cli.session_profile == SessionProfile::PublicTest && cli.command.is_some() {
        return Err(
            "--session-profile public-test is only valid for the interactive bare `hii` session"
                .into(),
        );
    }
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
            outcome,
            require_artifact,
            no_context,
            json,
            jsonl,
            quiet,
            stream,
            allow_missing_verify_deps,
            coding,
            autonomy,
            last_message,
        }) => {
            let workspace = cli
                .cwd
                .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
            let authority =
                resolve_authority(yolo, authority.as_deref(), AuthorityContext::Operator)?;
            let output = if jsonl {
                RunOutput::Jsonl
            } else if json {
                RunOutput::Json
            } else if quiet {
                RunOutput::Quiet
            } else {
                RunOutput::Human
            };
            let stream = if stream {
                StreamPolicy::Always
            } else if quiet {
                StreamPolicy::Never
            } else {
                StreamPolicy::Auto
            };
            let receipt = agent::run(
                &paths,
                RunOptions {
                    goal: goal.join(" "),
                    workspace,
                    model: cli.model,
                    review,
                    review_model,
                    max_steps: cli.max_steps,
                    dry_run,
                    verbose,
                    authority,
                    done_when,
                    verify,
                    outcome_requirements: contract::OutcomeRequirements::from_flags(
                        outcome.as_deref(),
                        &require_artifact,
                    )?,
                    use_context: !no_context,
                    output,
                    stream,
                    allow_missing_verify_deps,
                    budgets: Budgets {
                        max_steps: cli.max_steps,
                        wall_clock: match cli.deadline.as_deref() {
                            Some(value) => parse_duration(value)?,
                            None => Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
                        },
                        ..Budgets::default()
                    },
                    last_message,
                    hooks: lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
                    coding,
                    autonomy_level: autonomy.into(),
                },
            )?;
            // The receipt records the code it expects, so the shell and the
            // artifact can never disagree about how the run ended.
            Ok(ExitCode::from(receipt.exit_code))
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
            let ollama = Ollama::discover().ensure_reachable()?;
            let default_model = ollama.provider().default_model();
            let review_model = ollama.provider().default_review_model();
            for model in ollama.models()? {
                let role = if model == default_model {
                    "default"
                } else if model == review_model {
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
            let workspace = cli
                .cwd
                .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
            proof(&paths, &workspace, id.as_deref(), json)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Board { action }) => board_command(&paths, cli.cwd, action),
        Some(Commands::Discover { action }) => {
            match action {
                DiscoverCommand::Github {
                    query,
                    min_stars,
                    limit,
                } => println!(
                    "{}",
                    capability_discovery::search_github(&query.join(" "), min_stars, limit)?
                ),
                DiscoverCommand::X { query } => {
                    println!("{}", capability_discovery::search_x(&query.join(" "))?)
                }
                DiscoverCommand::Web { query } => {
                    println!("{}", capability_discovery::search_web(&query.join(" "))?)
                }
                DiscoverCommand::Install {
                    repo,
                    min_stars,
                    name,
                } => println!(
                    "{}",
                    capability_discovery::install_github(
                        &paths.repo,
                        &repo,
                        min_stars,
                        name.as_deref()
                    )?
                ),
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::ToolsManifest) => {
            println!("{}", acp::render());
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::McpServe {
            authority,
            client_identity,
        }) => {
            let workspace = cli
                .cwd
                .unwrap_or(env::current_dir().map_err(|error| error.to_string())?);
            let authority =
                resolve_authority(false, authority.as_deref(), AuthorityContext::Server)?;
            mcp::serve(&paths, &workspace, authority, client_identity.as_deref())
        }
        Some(Commands::AcpServe { authority }) => {
            let authority =
                resolve_authority(false, authority.as_deref(), AuthorityContext::Server)?;
            acp::serve(&paths, authority)
        }
        Some(Commands::Schedule { action }) => {
            let service = schedule::ScheduleService::new(&paths)?;
            match action {
                ScheduleCommand::Add { cron, task } => {
                    let workspace = cli.cwd.unwrap_or(paths.repo.clone());
                    println!("{}", service.add(&cron, &task.join(" "), &workspace)?);
                }
                ScheduleCommand::List => println!("{}", service.list()?),
                ScheduleCommand::Pause { id } => println!("{}", service.set_enabled(&id, false)?),
                ScheduleCommand::Resume { id } => println!("{}", service.set_enabled(&id, true)?),
                ScheduleCommand::Remove { id } => println!("{}", service.remove(&id)?),
                ScheduleCommand::Tick => println!("{}", service.tick()?),
            }
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
    let mut conversation = Conversation::new(
        paths,
        workspace,
        cli.model,
        cli.max_steps,
        cli.session_profile == SessionProfile::PublicTest,
        lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
    )?;
    let suppress_welcome = env::var("HII_SUPPRESS_WELCOME").ok();
    if !truthy_flag(suppress_welcome.as_deref()) {
        conversation.welcome();
    }
    // A line queued with Tab is carried forward and prepended to the next Submit.
    let mut queued: Option<String> = None;
    let mut input_history: Vec<String> = Vec::new();
    let interactive = keyboard::is_interactive();
    loop {
        for update in conversation.poll_background_updates()? {
            tui::system(&update);
        }
        for update in conversation.start_pending_backgrounds() {
            tui::system(&update);
        }
        let active_queue = conversation.take_queued();
        let goal = if let Some(pending) = active_queue {
            tui::system("Running queued follow-up.");
            pending
        } else if interactive {
            // Raw-mode keyboard model: Enter=submit, Tab=queue, Esc/Ctrl+B/Ctrl+T
            // are surfaced as events (interrupt/background/task-view meaning applies
            // during a run; at the idle prompt they are informational).
            match keyboard::read_event(
                conversation.is_public_test(),
                &input_history,
                conversation.keymap(),
            )
            .map_err(|error| error.to_string())?
            {
                keyboard::InputEvent::Submit(line) => {
                    if !line.trim().is_empty()
                        && input_history
                            .last()
                            .is_none_or(|previous| previous != &line)
                    {
                        input_history.push(line.clone());
                    }
                    match queued.take() {
                        Some(pending) if line.trim().is_empty() => pending,
                        Some(pending) => format!("{pending}\n{line}"),
                        None => line,
                    }
                }
                keyboard::InputEvent::Queue(line) => {
                    if !line.trim().is_empty() {
                        queued = Some(line);
                        tui::queued();
                    }
                    continue;
                }
                keyboard::InputEvent::TaskView => {
                    tui::system(&conversation.task_view());
                    continue;
                }
                keyboard::InputEvent::Interrupt => break,
                keyboard::InputEvent::Background(goal) => {
                    if goal.trim().is_empty() {
                        tui::idle_background();
                    } else {
                        match conversation.background(&goal) {
                            Ok(result) => tui::system(&result),
                            Err(error) => tui::error(&error),
                        }
                    }
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
            if conversation.is_public_test() {
                tui::system(
                    "Direct shell input is unavailable in the public test. Ask HII to use the host tool inside this workspace.",
                );
                continue;
            }
            let output = conversation.shell_interactive(command.trim());
            if output != "ok" {
                tui::system(&output);
            }
            continue;
        }
        let mut show_activity = false;
        let slash = parse_slash_command(goal);
        if conversation.is_public_test()
            && slash
                .as_ref()
                .is_some_and(|command| !public_test_slash_allowed(command))
        {
            tui::system("That control is unavailable in the isolated public test.");
            continue;
        }
        let result = match slash {
            Some(SlashCommand::Help) => Ok(if conversation.is_public_test() {
                public_test_slash_help().to_string()
            } else {
                slash_help()
            }),
            Some(SlashCommand::Compact) => conversation.compact(),
            Some(SlashCommand::Clear) => conversation.clear(),
            Some(SlashCommand::Status) => Ok(conversation.status()),
            Some(SlashCommand::Attach(path)) => conversation.attach(&path),
            Some(SlashCommand::Attachments) => Ok(conversation.attachments()),
            Some(SlashCommand::Detach(requested)) => conversation.detach(requested.as_deref()),
            Some(SlashCommand::Goal(goal)) => conversation.goal(goal.as_deref()),
            Some(SlashCommand::Plan(requested)) => match requested.as_deref() {
                Some("off") => conversation.plan(false),
                None | Some("on") => conversation.plan(true),
                Some(prompt) => conversation.plan(true).and_then(|_| {
                    show_activity = true;
                    conversation.reply(prompt)
                }),
            },
            Some(SlashCommand::Usage) => Ok(conversation.usage()),
            Some(SlashCommand::Thinking(mode)) => conversation.thinking(mode.as_deref()),
            Some(SlashCommand::Reasoning(mode)) => conversation.reasoning(mode.as_deref()),
            Some(SlashCommand::Mode(mode)) => conversation.mode(mode.as_deref()),
            Some(SlashCommand::Autonomy(mode)) => conversation.autonomy(mode.as_deref()),
            Some(SlashCommand::Learn(requested)) => conversation.learn(&requested),
            Some(SlashCommand::Theme(theme)) => conversation.theme(theme.as_deref()),
            Some(SlashCommand::Keymap(requested)) => {
                conversation.keymap_command(requested.as_deref())
            }
            Some(SlashCommand::Model(model)) => conversation.model(model.as_deref()),
            Some(SlashCommand::Proof(id)) => conversation.proof(id.as_deref()),
            Some(SlashCommand::Diff) => conversation.diff(),
            Some(SlashCommand::Review) => conversation.review(),
            Some(SlashCommand::Side(prompt)) => {
                show_activity = true;
                conversation.side(&prompt)
            }
            Some(SlashCommand::Permissions(authority)) => {
                conversation.permissions(authority.as_deref())
            }
            Some(SlashCommand::Resume(id)) => conversation.resume(id.as_deref()),
            Some(SlashCommand::Skills) => conversation.skills(),
            Some(SlashCommand::Hooks) => Ok(conversation.hooks()),
            Some(SlashCommand::Mcp(requested)) => conversation.mcp_command(&requested),
            Some(SlashCommand::Background(goal)) => conversation.background(&goal),
            Some(SlashCommand::Jobs) => conversation.jobs(),
            Some(SlashCommand::Job { id, action }) => conversation.job(&id, &action),
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
            Some(SlashCommand::Copy) => conversation.copy_latest(),
            Some(SlashCommand::Rename(name)) => conversation.rename(&name),
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
            Some(SlashCommand::Schedule { cron, task }) => schedule::ScheduleService::new(
                conversation.paths(),
            )?
            .add(&cron, &task, conversation.workspace()),
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
                let help = if conversation.is_public_test() {
                    public_test_slash_help().to_string()
                } else {
                    slash_help()
                };
                Ok(format!("Unknown command: {command}\n\n{help}"))
            }
            None => {
                show_activity = true;
                conversation.reply(goal)
            }
        };
        match result {
            Ok(reply) => {
                let reply = if show_activity {
                    conversation.final_output(&reply)
                } else {
                    reply
                };
                if !reply.trim().is_empty() {
                    tui::reply(&reply, None);
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
    Attach(String),
    Attachments,
    Detach(Option<String>),
    Goal(Option<String>),
    Plan(Option<String>),
    Usage,
    Thinking(Option<String>),
    Reasoning(Option<String>),
    Mode(Option<String>),
    Autonomy(Option<String>),
    Learn(String),
    Theme(Option<String>),
    Keymap(Option<String>),
    Model(Option<String>),
    Proof(Option<String>),
    Diff,
    Review,
    Side(String),
    Permissions(Option<String>),
    Resume(Option<String>),
    Skills,
    Hooks,
    Mcp(String),
    Background(String),
    Jobs,
    Job {
        id: String,
        action: String,
    },
    Agents,
    Providers,
    Login(String),
    Codex(String),
    Claude(String),
    Copy,
    Rename(String),
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
        "/attach" if argument.is_some() => SlashCommand::Attach(rest.to_string()),
        "/attachments" if argument.is_none() => SlashCommand::Attachments,
        "/detach" => SlashCommand::Detach(argument),
        "/goal" => SlashCommand::Goal(argument),
        "/plan" => SlashCommand::Plan(argument),
        "/usage" if argument.is_none() => SlashCommand::Usage,
        "/thinking" => SlashCommand::Thinking(argument),
        "/reasoning" => SlashCommand::Reasoning(argument),
        "/mode" => SlashCommand::Mode(argument),
        "/autonomy" => SlashCommand::Autonomy(argument),
        "/learn" => SlashCommand::Learn(rest.to_string()),
        "/theme" => SlashCommand::Theme(argument),
        "/keymap" => SlashCommand::Keymap(argument),
        "/raw" => match rest {
            "" | "on" => SlashCommand::Thinking(Some("raw".into())),
            "off" => SlashCommand::Thinking(Some("compact".into())),
            _ => SlashCommand::Unknown(input.into()),
        },
        "/model" => SlashCommand::Model(argument),
        "/models" if rest.is_empty() => SlashCommand::Model(None),
        "/proof" => SlashCommand::Proof(argument),
        "/diff" if argument.is_none() => SlashCommand::Diff,
        "/review" if argument.is_none() => SlashCommand::Review,
        "/side" => SlashCommand::Side(rest.to_string()),
        "/permissions" => SlashCommand::Permissions(argument),
        "/resume" => SlashCommand::Resume(argument),
        "/skills" if rest.is_empty() => SlashCommand::Skills,
        "/hooks" if rest.is_empty() => SlashCommand::Hooks,
        "/mcp" => SlashCommand::Mcp(rest.to_string()),
        "/background" | "/bg" => SlashCommand::Background(rest.to_string()),
        "/jobs" | "/tasks" if rest.is_empty() => SlashCommand::Jobs,
        "/job" => {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            match parts.as_slice() {
                [id] => SlashCommand::Job {
                    id: (*id).into(),
                    action: "status".into(),
                },
                [id, action] => SlashCommand::Job {
                    id: (*id).into(),
                    action: (*action).into(),
                },
                _ => SlashCommand::Unknown(input.into()),
            }
        }
        "/agents" if rest.is_empty() => SlashCommand::Agents,
        "/ps" if rest.is_empty() => SlashCommand::Agents,
        "/providers" if rest.is_empty() => SlashCommand::Providers,
        "/login" => SlashCommand::Login(rest.to_ascii_lowercase()),
        "/codex" => SlashCommand::Codex(rest.to_string()),
        "/claude" => SlashCommand::Claude(rest.to_string()),
        "/copy" if rest.is_empty() => SlashCommand::Copy,
        "/rename" => SlashCommand::Rename(rest.to_string()),
        "/undo" if argument.is_none() => SlashCommand::Undo,
        "/new" if argument.is_none() => SlashCommand::Clear,
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
        "/stop" if !rest.is_empty() && !rest.contains(char::is_whitespace) => SlashCommand::Agent {
            id: rest.into(),
            action: "stop".into(),
        },
        #[cfg(feature = "preview")]
        "/resources" if rest.is_empty() => SlashCommand::Resources,
        #[cfg(feature = "preview")]
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

fn slash_help() -> String {
    let help = if cfg!(feature = "preview") {
        "/help                         show commands\n/providers                    show local, Codex, and Claude access\n/login codex|claude           connect an existing provider plan\n/compact                      summarize and shrink this conversation\n/clear | /new                 start with fresh context\n/rename <name>                name this saved session\n/copy                         copy the latest response\n/status                       show session, workspace, model, and usage\n/goal [edit|pause|resume|clear] [objective]\n                               track a persistent session objective\n/plan [off|prompt]            inspect and research without changes\n/side <question>              ask without changing the main conversation\n/theme [name]                 switch the persistent visual signature\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw model stream\n/raw [on|off]                 toggle the raw model stream\n/model [name]                 list or switch available models\n/proof [run-id]               inspect execution proof\n/diff                         inspect scoped workspace changes\n/review                       review current diff for defects\n/permissions [level]          show or switch the live authority boundary\n/resume [session-id]          list or restore a prior session\n/skills                       show automatically learned skill drafts\n/agents | /ps                 show HII-managed and observed agents\n/codex <task>                 use authenticated Codex CLI\n/claude <task>                use authenticated Claude CLI\n/agent <id> status|logs|stop  manage an agent by id\n/stop <id>                    stop one managed agent\n/resources                    quick CPU, memory, storage, and Ollama view\n/top                          open the embedded btop resource monitor\n/schedule <cron> :: <task>    create a local recurring HII task\n/schedules                    list HII schedules\n/calendar                     show the next 7 days\n/calendar add DATE [TIME] :: TITLE\n/sync calendar                sync next HII runs to Apple Calendar\n/exit                         leave HII\n\nWhile running: type + Enter steers · type + Tab queues · Esc stops"
    } else {
        "/help                         show commands\n/providers                    show local, Codex, and Claude access\n/login codex|claude           connect an existing provider plan\n/compact                      summarize and shrink this conversation\n/clear | /new                 start with fresh context\n/rename <name>                name this saved session\n/copy                         copy the latest response\n/status                       show session, workspace, model, and usage\n/goal [edit|pause|resume|clear] [objective]\n                               track a persistent session objective\n/plan [off|prompt]            inspect and research without changes\n/side <question>              ask without changing the main conversation\n/theme [name]                 switch the persistent visual signature\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw model stream\n/raw [on|off]                 toggle the raw model stream\n/model [name]                 list or switch available models\n/proof [run-id]               inspect execution proof\n/diff                         inspect scoped workspace changes\n/review                       review current diff for defects\n/permissions [level]          show or switch the live authority boundary\n/resume [session-id]          list or restore a prior session\n/skills                       show automatically learned skill drafts\n/agents | /ps                 show HII-managed and observed agents\n/codex <task>                 use authenticated Codex CLI\n/claude <task>                use authenticated Claude CLI\n/agent <id> status|logs|stop  manage an agent by id\n/stop <id>                    stop one managed agent\n/schedule <cron> :: <task>    create local recurring HII work\n/schedules                    list recurring HII work\n/calendar                     show the next 7 days\n/calendar add DATE [TIME] :: TITLE\n/sync calendar                sync HII schedules to Apple Calendar\n/undo                         drop the last exchange to steer away\n/fork                         snapshot this session to a resumable fork\n/teach <name>                 graduate this session into a reusable skill\n!<command>                    run a shell command directly\n/exit                         leave HII\n\nWhile running: type + Enter steers · type + Tab queues · Esc stops"
    };
    help.replace(
        "/skills                       show automatically learned skill drafts\n",
        "/skills                       show automatically learned skill drafts\n/hooks                        inspect approved lifecycle policy\n/mcp                          show governed MCP clients\n/mcp add|refresh|show|trust   configure and discover MCP tools\n/background <task>            start one supervised local HII job\n/jobs                         list background jobs\n/job <id> status|logs|proof|cancel\n                               inspect or stop one background job\n",
    )
    .replace(
        "/status                       show session, workspace, model, and usage\n",
        "/status                       show session, workspace, model, and usage\n/attach <path>                add workspace text/image context\n/attachments                  show pending context and size\n/detach [number|all]          remove pending context\n",
    )
    .replace(
        "/theme [name]                 switch the persistent visual signature\n",
        "/theme [name]                 switch the persistent visual signature\n/keymap [default|vim]          inspect or switch keyboard profile\n/keymap bind ACTION CHORD      add a safe custom binding\n",
    )
    .replace(
        "/thinking [mode]              off | compact | raw model stream\n",
        "/thinking [mode]              off | compact | raw display\n/reasoning [mode]             auto | off | deep model effort\n/mode [coding|general|auto|local|private|best]\n                               choose coding behavior or provider routing\n/autonomy [local-full|approval]\n                               choose local autonomy policy\n/model save                   persist the current user-determined model\n/learn [status]               show learning memory\nAuto-compact is on by default.\n",
    )
}

fn public_test_slash_help() -> String {
    "/help                         show commands\n/compact                      summarize and shrink this conversation\n/clear | /new                 start with fresh context\n/status                       show isolated session, workspace, model, and usage\n/attach <path>                add workspace text/image context\n/attachments                  show pending context and size\n/detach [number|all]          remove pending context\n/theme [name]                 switch the terminal theme\n/keymap [default|vim]          inspect or switch keyboard profile\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw display\n/reasoning [mode]             auto | off | deep model effort\n/raw [on|off]                 toggle the raw model stream\n/model [name]                 list or switch available models\n/proof [run-id]               inspect isolated execution proof\n/permissions                  show the tester-safe authority boundary\n/undo                         drop the last exchange\n/exit                         leave HII\n\nAttachments must already exist inside this disposable workspace. Installed Mac tools are available to HII inside it. Direct shell input and deletion are unavailable."
        .to_string()
}

fn lifecycle_hooks_enabled(no_hooks: bool, profile: SessionProfile) -> bool {
    !no_hooks && profile != SessionProfile::PublicTest
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
    let ollama = Ollama::discover();
    let models = ollama.models().unwrap_or_default();
    // Scoped to this workspace so `proof      hii proof <id>` points at a run
    // that actually happened here.
    let latest = find_receipt(&paths.runtime, None, &workspace)
        .ok()
        .and_then(|path| {
            let raw = fs::read_to_string(path).ok()?;
            serde_json::from_str::<Receipt>(&raw).ok()
        })
        .map(|receipt| receipt.id)
        .unwrap_or_default();
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
                "provider": ollama.provider_label(),
                "defaultModel": ollama.provider().default_model(),
                "reviewModel": ollama.provider().default_review_model(),
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
            ollama.provider().default_model(),
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
    let ollama = Ollama::discover();
    match ollama.models() {
        Ok(models) => {
            let default_model = ollama.provider().default_model();
            let review_model = ollama.provider().default_review_model();
            let default = models.iter().any(|model| model == default_model);
            let review = models.iter().any(|model| model == review_model);
            ok &= default;
            println!(
                "{}  {:<14} {}",
                if default { "ok" } else { "!!" },
                format!("{} agent", ollama.provider_label()),
                default_model
            );
            println!(
                "{}  {:<14} {}",
                if review { "ok" } else { "--" },
                format!("{} review", ollama.provider_label()),
                review_model
            );
        }
        Err(error) => {
            ok = false;
            println!("!!  {:<14} {error}", ollama.provider_label());
        }
    }
    println!("\n{}", if ok { "ready" } else { "not ready" });
    Ok(ok)
}

fn proof(
    paths: &AppPaths,
    workspace: &std::path::Path,
    id: Option<&str>,
    json: bool,
) -> Result<(), String> {
    // Without an explicit id the lookup is bound to this workspace, so an empty
    // workspace reports that plainly instead of showing another workspace's run.
    let path = find_receipt(&paths.runtime, id, workspace)?;
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if json {
        println!("{raw}");
        return Ok(());
    }
    let receipt: Receipt = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    println!("HII proof {}", receipt.id);
    println!("status     {}", receipt.status);
    if !receipt.outcome.is_empty() && receipt.outcome != receipt.status {
        println!("outcome    {}", receipt.outcome);
    }
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
            acceptance_criteria,
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
            let task = if acceptance_criteria.is_empty() {
                task
            } else {
                store.update(
                    &task.id,
                    board::EditPatch {
                        acceptance_criteria: Some(acceptance_criteria),
                        ..Default::default()
                    },
                )?
            };
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
        BoardCommand::Approve { id, lane } => {
            let task = store.approve(&id, lane)?;
            println!(
                "approved {} -> {}",
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
            title,
            priority,
            owner,
            coordinate,
            notes,
            acceptance_criteria,
            tags,
        } => {
            let task = store.update(
                &id,
                board::EditPatch {
                    lane: None,
                    title,
                    priority,
                    owner,
                    coordinate,
                    notes,
                    acceptance_criteria: if acceptance_criteria.is_empty() {
                        None
                    } else {
                        Some(acceptance_criteria)
                    },
                    tags,
                    review_state: None,
                    approved_by: None,
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

/// Long and short forms of every global flag that consumes a following value.
///
/// Derived from the clap definition rather than hand-listed so that adding a new
/// global flag cannot silently break goal normalization by leaving its value to be
/// mistaken for the subcommand (`hii --deadline 10m "fix tests"` must not run the
/// `10m` subcommand).
/// Parse a human duration such as `90s`, `15m`, or `1h`. `0` disables the bound.
fn parse_duration(value: &str) -> Result<Option<Duration>, String> {
    let trimmed = value.trim();
    if trimmed == "0" || trimmed.eq_ignore_ascii_case("none") || trimmed.eq_ignore_ascii_case("off")
    {
        return Ok(None);
    }
    let (digits, multiplier) = match trimmed.chars().last() {
        Some('s') | Some('S') => (&trimmed[..trimmed.len() - 1], 1),
        Some('m') | Some('M') => (&trimmed[..trimmed.len() - 1], 60),
        Some('h') | Some('H') => (&trimmed[..trimmed.len() - 1], 3_600),
        _ => (trimmed, 1),
    };
    let amount: u64 = digits.trim().parse().map_err(|_| {
        format!("cannot read duration '{value}'; use forms like 90s, 15m, 1h, or 0")
    })?;
    Ok(Some(Duration::from_secs(amount * multiplier)))
}

fn value_taking_globals() -> &'static [String] {
    use clap::CommandFactory;
    use std::sync::OnceLock;
    static FLAGS: OnceLock<Vec<String>> = OnceLock::new();
    FLAGS.get_or_init(|| {
        Cli::command()
            .get_arguments()
            .filter(|arg| {
                arg.is_global_set()
                    && matches!(
                        arg.get_action(),
                        clap::ArgAction::Set | clap::ArgAction::Append
                    )
            })
            .flat_map(|arg| {
                arg.get_long()
                    .map(|long| format!("--{long}"))
                    .into_iter()
                    .chain(arg.get_short().map(|short| format!("-{short}")))
            })
            .collect()
    })
}

fn first_command(args: &[String]) -> Option<&str> {
    let value_flags = value_taking_globals();
    let mut skip_value = false;
    for arg in args {
        if skip_value {
            skip_value = false;
            continue;
        }
        if arg.starts_with('-') {
            // `--flag=value` carries its value inline, so nothing after it is consumed.
            if !arg.contains('=') && value_flags.iter().any(|flag| flag == arg) {
                skip_value = true;
            }
            continue;
        }
        return Some(arg);
    }
    None
}

fn public_test_slash_allowed(command: &SlashCommand) -> bool {
    matches!(
        command,
        SlashCommand::Help
            | SlashCommand::Compact
            | SlashCommand::Clear
            | SlashCommand::Status
            | SlashCommand::Attach(_)
            | SlashCommand::Attachments
            | SlashCommand::Detach(_)
            | SlashCommand::Usage
            | SlashCommand::Thinking(_)
            | SlashCommand::Reasoning(_)
            | SlashCommand::Mode(_)
            | SlashCommand::Theme(_)
            | SlashCommand::Keymap(_)
            | SlashCommand::Model(_)
            | SlashCommand::Proof(_)
            | SlashCommand::Permissions(None)
            | SlashCommand::Undo
            | SlashCommand::Unknown(_)
    )
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
            | "discover"
            | "legacy"
            | "help"
            | "tools-manifest"
            | "mcp-serve"
            | "acp-serve"
    ) || command == "schedule"
}

fn command_suggestion(args: &[String]) -> Option<(String, &'static str)> {
    let typed = first_command(args)?;
    if is_native_command(typed) || legacy::is_legacy(typed) || typed.len() < 3 {
        return None;
    }
    let commands = [
        "run",
        "status",
        "doctor",
        "models",
        "providers",
        "login",
        "proof",
        "board",
        "discover",
        "help",
        "home",
        "agents",
        "context",
        "now",
        "task",
        "work",
        "check",
        "ship",
        "caps",
        "jobs",
        "daemon",
        "space",
        "knowledge",
        "skill",
        "bridge",
        "codex",
    ];
    commands
        .into_iter()
        .find(|candidate| {
            edit_distance(typed, candidate) <= 1 || adjacent_transposition(typed, candidate)
        })
        .map(|suggestion| (typed.to_string(), suggestion))
}

fn adjacent_transposition(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let differences = left
        .iter()
        .zip(right)
        .enumerate()
        .filter_map(|(index, (a, b))| (a != b).then_some(index))
        .collect::<Vec<_>>();
    differences.len() == 2
        && differences[1] == differences[0] + 1
        && left[differences[0]] == right[differences[1]]
        && left[differences[1]] == right[differences[0]]
}

fn edit_distance(left: &str, right: &str) -> usize {
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    for (left_index, left_byte) in left.bytes().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_byte) in right.bytes().enumerate() {
            current.push(
                (current[right_index] + 1)
                    .min(previous[right_index + 1] + 1)
                    .min(previous[right_index] + usize::from(left_byte != right_byte)),
            );
        }
        previous = current;
    }
    previous[right.len()]
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

fn truthy_flag(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
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
/// Where authority is being resolved. Servers are held to a stricter rule than
/// an interactive run because nobody is present to notice what they are doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthorityContext {
    /// `hii run` or the REPL: the operator is present and typed the command.
    Operator,
    /// A long-lived stdio server whose caller is another program.
    Server,
}

fn resolve_authority(
    yolo: bool,
    level: Option<&str>,
    context: AuthorityContext,
) -> Result<contract::Authority, String> {
    use contract::Authority;
    if yolo {
        return Ok(Authority::Yolo);
    }
    // HII_YOLO used to escalate every command in the process, including
    // `mcp-serve` and `acp-serve`. An ambient environment variable should not
    // silently grant unbounded authority to a server a client is driving, so it
    // is honored only where the operator invoked the work directly.
    if context == AuthorityContext::Operator
        && matches!(
            std::env::var("HII_YOLO").ok().as_deref(),
            Some("1") | Some("true")
        )
    {
        return Ok(Authority::Yolo);
    }
    match level
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        None => Ok(Authority::Workspace),
        Some(value) => Authority::parse(value),
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
        "daemon", "loop", "feed", "space", "probe", "check",
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
    fn discover_command_is_preserved() {
        let args = vec![
            "hii".into(),
            "discover".into(),
            "github".into(),
            "cad".into(),
        ];
        assert_eq!(normalize_goal_args(args.clone()), args);
    }

    #[test]
    fn command_typos_are_suggested_without_capturing_normal_goals() {
        assert_eq!(
            command_suggestion(&["staus".into()]),
            Some(("staus".into(), "status"))
        );
        assert_eq!(
            command_suggestion(&["contxt".into()]),
            Some(("contxt".into(), "context"))
        );
        assert_eq!(command_suggestion(&["fix".into(), "tests".into()]), None);
    }

    /// Every global flag that takes a value must have that value skipped when we
    /// look for the subcommand. Driving the assertion off the derived list means a
    /// newly added global flag is covered automatically instead of silently
    /// regressing `normalize_goal_args`.
    #[test]
    fn first_command_skips_the_value_of_every_global_flag() {
        let flags = value_taking_globals();
        assert!(
            flags.iter().any(|flag| flag == "--cwd"),
            "expected --cwd to be derived as a value-taking global, got {flags:?}"
        );
        for flag in flags {
            let args = vec![flag.clone(), "status".into(), "fix the bug".into()];
            assert_eq!(
                first_command(&args),
                Some("fix the bug"),
                "{flag}'s value was mistaken for the subcommand"
            );
        }
    }

    #[test]
    fn first_command_reads_inline_flag_values() {
        let args = vec!["--model=status".into(), "doctor".into()];
        assert_eq!(first_command(&args), Some("doctor"));
    }

    /// Unattended runs need a bound by default; `0` remains the explicit opt-out.
    #[test]
    fn cli_has_a_step_ceiling_by_default_but_zero_still_disables_it() {
        let cli = Cli::try_parse_from(["hii"]).expect("parse default CLI");
        assert_eq!(cli.max_steps, DEFAULT_MAX_STEPS);
        assert!(cli.max_steps > 0, "an unattended run must be bounded");
        assert_eq!(cli.session_profile, SessionProfile::Local);
        assert!(!cli.no_hooks);

        let unlimited =
            Cli::try_parse_from(["hii", "--max-steps", "0"]).expect("parse explicit unlimited");
        assert_eq!(unlimited.max_steps, 0);
    }

    /// An ambient environment variable must not grant a stdio server unbounded
    /// authority; only an operator-invoked run honors HII_YOLO.
    #[test]
    fn hii_yolo_does_not_escalate_servers() {
        use contract::Authority;
        assert_eq!(
            resolve_authority(true, None, AuthorityContext::Operator).expect("explicit flag"),
            Authority::Yolo
        );
        assert_eq!(
            resolve_authority(false, None, AuthorityContext::Server).expect("server default"),
            Authority::Workspace
        );
        assert_eq!(
            resolve_authority(false, Some("read-only"), AuthorityContext::Server)
                .expect("server explicit"),
            Authority::ReadOnly
        );
    }

    #[test]
    fn durations_accept_common_suffixes() {
        assert_eq!(
            parse_duration("90s").expect("secs"),
            Some(Duration::from_secs(90))
        );
        assert_eq!(
            parse_duration("15m").expect("mins"),
            Some(Duration::from_secs(900))
        );
        assert_eq!(
            parse_duration("1h").expect("hours"),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(
            parse_duration("45").expect("bare"),
            Some(Duration::from_secs(45))
        );
        assert_eq!(parse_duration("0").expect("disabled"), None);
        assert!(parse_duration("soon").is_err());
    }

    #[test]
    fn no_hooks_is_a_global_session_control() {
        let cli =
            Cli::try_parse_from(["hii", "--no-hooks", "run", "inspect"]).expect("parse no-hooks");
        assert!(cli.no_hooks);
    }

    #[test]
    fn lifecycle_hooks_never_cross_the_public_test_boundary() {
        assert!(lifecycle_hooks_enabled(false, SessionProfile::Local));
        assert!(!lifecycle_hooks_enabled(true, SessionProfile::Local));
        assert!(!lifecycle_hooks_enabled(false, SessionProfile::PublicTest));
    }

    #[test]
    fn welcome_suppression_uses_an_explicit_truthy_flag() {
        assert!(truthy_flag(Some("1")));
        assert!(truthy_flag(Some("TRUE")));
        assert!(!truthy_flag(Some("0")));
        assert!(!truthy_flag(None));
    }

    #[test]
    fn run_parses_structured_output_and_last_message_after_goal() {
        let cli = Cli::try_parse_from([
            "hii",
            "run",
            "build",
            "the",
            "site",
            "--jsonl",
            "--last-message",
            "output/final.txt",
        ])
        .expect("parse structured run");
        assert!(matches!(
            cli.command,
            Some(Commands::Run {
                goal,
                json: false,
                jsonl: true,
                last_message: Some(path),
                ..
            }) if goal == ["build", "the", "site"] && path == Path::new("output/final.txt")
        ));
    }

    #[test]
    fn run_structured_output_modes_conflict() {
        assert!(Cli::try_parse_from(["hii", "run", "--json", "--jsonl", "inspect"]).is_err());
        assert!(Cli::try_parse_from(["hii", "run", "--json", "--verbose", "inspect"]).is_err());
    }

    #[test]
    fn parses_public_test_profile_without_turning_it_into_a_goal() {
        let args = normalize_goal_args(
            [
                "hii",
                "--cwd",
                "/tmp/arry",
                "--model",
                "qwen3.6:35b-mlx",
                "--session-profile",
                "public-test",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        );
        let cli = Cli::try_parse_from(args).expect("parse public test CLI");
        assert_eq!(cli.session_profile, SessionProfile::PublicTest);
        assert!(cli.command.is_none());
    }

    #[test]
    fn parses_conversational_controls() {
        assert_eq!(
            parse_slash_command("/model qwen3.6:35b-mlx"),
            Some(SlashCommand::Model(Some("qwen3.6:35b-mlx".into())))
        );
        assert_eq!(
            parse_slash_command("/attach references/hero image.png"),
            Some(SlashCommand::Attach("references/hero image.png".into()))
        );
        assert_eq!(
            parse_slash_command("/attachments"),
            Some(SlashCommand::Attachments)
        );
        assert_eq!(
            parse_slash_command("/detach 2"),
            Some(SlashCommand::Detach(Some("2".into())))
        );
        assert_eq!(
            parse_slash_command("/login codex"),
            Some(SlashCommand::Login("codex".into()))
        );
        assert_eq!(
            parse_slash_command("/providers"),
            Some(SlashCommand::Providers)
        );
        assert_eq!(parse_slash_command("/diff"), Some(SlashCommand::Diff));
        assert_eq!(parse_slash_command("/review"), Some(SlashCommand::Review));
        assert_eq!(
            parse_slash_command("/side explain this diff"),
            Some(SlashCommand::Side("explain this diff".into()))
        );
        assert_eq!(
            parse_slash_command("/permissions"),
            Some(SlashCommand::Permissions(None))
        );
        assert_eq!(
            parse_slash_command("/permissions read-only"),
            Some(SlashCommand::Permissions(Some("read-only".into())))
        );
        assert_eq!(
            parse_slash_command("/resume abc-123"),
            Some(SlashCommand::Resume(Some("abc-123".into())))
        );
        assert_eq!(parse_slash_command("/new"), Some(SlashCommand::Clear));
        assert_eq!(
            parse_slash_command("/raw off"),
            Some(SlashCommand::Thinking(Some("compact".into())))
        );
        assert_eq!(
            parse_slash_command("/reasoning auto"),
            Some(SlashCommand::Reasoning(Some("auto".into())))
        );
        assert_eq!(
            parse_slash_command("/mode private"),
            Some(SlashCommand::Mode(Some("private".into())))
        );
        assert_eq!(
            parse_slash_command("/theme heritage"),
            Some(SlashCommand::Theme(Some("heritage".into())))
        );
        assert_eq!(
            parse_slash_command("/keymap vim"),
            Some(SlashCommand::Keymap(Some("vim".into())))
        );
        assert_eq!(
            parse_slash_command("/keymap bind background ctrl+g"),
            Some(SlashCommand::Keymap(Some("bind background ctrl+g".into())))
        );
        assert_eq!(parse_slash_command("/copy"), Some(SlashCommand::Copy));
        assert_eq!(
            parse_slash_command("/rename release prep"),
            Some(SlashCommand::Rename("release prep".into()))
        );
        assert_eq!(
            parse_slash_command("/goal ship the verified CLI"),
            Some(SlashCommand::Goal(Some("ship the verified CLI".into())))
        );
        assert_eq!(
            parse_slash_command("/goal pause"),
            Some(SlashCommand::Goal(Some("pause".into())))
        );
        assert_eq!(parse_slash_command("/plan"), Some(SlashCommand::Plan(None)));
        assert_eq!(
            parse_slash_command("/plan inspect auth boundaries"),
            Some(SlashCommand::Plan(Some("inspect auth boundaries".into())))
        );
        assert_eq!(
            parse_slash_command("/plan off"),
            Some(SlashCommand::Plan(Some("off".into())))
        );
        assert_eq!(parse_slash_command("/ps"), Some(SlashCommand::Agents));
        assert_eq!(parse_slash_command("/hooks"), Some(SlashCommand::Hooks));
        assert_eq!(
            parse_slash_command("/mcp refresh local"),
            Some(SlashCommand::Mcp("refresh local".into()))
        );
        assert_eq!(
            parse_slash_command("/background inspect the failing tests"),
            Some(SlashCommand::Background("inspect the failing tests".into()))
        );
        assert_eq!(parse_slash_command("/jobs"), Some(SlashCommand::Jobs));
        assert_eq!(
            parse_slash_command("/job deadbeef logs"),
            Some(SlashCommand::Job {
                id: "deadbeef".into(),
                action: "logs".into()
            })
        );
        assert_eq!(
            parse_slash_command("/stop worker-7"),
            Some(SlashCommand::Agent {
                id: "worker-7".into(),
                action: "stop".into()
            })
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
    fn preview_only_system_monitor_commands_are_unreachable_by_default() {
        assert!(is_native_command("schedule"));
        assert!(!legacy::is_legacy("schedule"));
        for command in ["/resources", "/top"] {
            assert_eq!(
                parse_slash_command(command),
                Some(SlashCommand::Unknown(command.into()))
            );
        }
    }

    #[test]
    fn parses_native_schedule_and_calendar_controls() {
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
