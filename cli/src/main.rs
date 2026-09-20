// SPDX-License-Identifier: LicenseRef-BSL-1.1
mod account;
mod acp;
mod agent;
mod agents;
mod applications;
mod ask;
mod attachments;
mod background;
mod board;
mod budget;
mod capability_discovery;
mod capability_index;
mod capability_resolver;
mod clean;
mod clock;
mod completion;
mod config;
mod context;
mod context_budget;
mod contract;
mod conversation;
mod declaration;
mod design;
mod ecosystem_catalog;
mod file_explorer;
mod governance;
mod hii_tools;
mod hooks;
mod identity;
mod inference_view;
mod keyboard;
mod keymap;
mod learning;
mod ledger_audit;
mod legacy;
mod local_chat;
mod mcp;
mod mcp_client;
mod memory;
mod mirror;
mod model_task;
mod network;
mod notification;
mod ollama;
mod paste;
mod picker;
mod pipe;
mod presence;
mod project;
mod receipt;
mod remote_cli;
mod route;
mod run_context;
mod runlog;
mod schedule;
mod service;
mod session_backup;
mod skill_lifecycle;
mod skill_runtime;
mod skills;
mod slash_registry;
// mod drive; // preview surface: hii-drive compiles as a workspace crate, but this CLI module is not wired to a subcommand yet
mod settings;
mod store;
mod stream;
#[cfg(feature = "preview")]
mod system_monitor;
mod terminal_image;
mod text;
mod timeline;
mod tool_artifacts;
mod tools;
mod tui;
mod usefulness;
mod vpn;
mod web_cmd;

use agent::{AutonomyLevel, RunOptions, RunOutput};
use budget::{Budgets, DEFAULT_WALL_CLOCK_SECS};
use clap::{Parser, Subcommand, ValueEnum};
use config::{AppPaths, ModelProvider, DEFAULT_MAX_STEPS};
use conversation::Conversation;
use ollama::Ollama;
use receipt::{find_receipt, Receipt};
use runlog::StreamPolicy;
use serde::{Deserialize, Serialize};
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
    long_about = legacy::intro_resolved(),
    after_help = legacy::help_footer_resolved()
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
        help = "Local model ID for the HII work loop"
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
        default_value_t = 0,
        value_name = "TOKENS",
        help = "Cumulative prompt plus completion token budget; 0 means unlimited"
    )]
    token_budget: u64,

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
enum DoctorCommand {
    #[command(about = "Run the real bare `hii` interactive startup smoke test")]
    Interactive {
        #[arg(
            long,
            help = "Use the persisted local runtime/model instead of an isolated fake model"
        )]
        real: bool,
    },
}

#[derive(Subcommand, Debug)]
enum Commands {
    #[command(about = "Save, watch, search, and restore local file memory")]
    #[command(hide = true)]
    Memory {
        #[command(subcommand)]
        action: memory::MemoryCommand,
    },
    #[command(about = "Back up and restore local Codex, Claude and Pi session logs")]
    #[command(hide = true)]
    SessionBackup {
        #[command(subcommand)]
        action: session_backup::SessionBackupCommand,
    },
    #[command(about = "Inspect and run durable local chat shared with the desktop")]
    Chat {
        #[command(subcommand)]
        action: local_chat::ChatCommand,
    },
    #[command(about = "Stream one direct answer from the fastest configured local model")]
    Ask {
        #[arg(required = true, num_args = 1..)]
        prompt: Vec<String>,
        #[arg(
            long = "source",
            value_name = "PATH",
            action = clap::ArgAction::Append,
            help = "Attach a UTF-8 text source to the local-model prompt (repeatable)"
        )]
        sources: Vec<PathBuf>,
        #[arg(
            long,
            help = "Stream machine-readable answer events, one JSON object per line"
        )]
        jsonl: bool,
    },
    #[command(about = "Create a native shell terminal object in the current HII Space")]
    #[command(hide = true)]
    Terminal {
        #[arg(value_name = "DIRECTORY", help = "Working directory for the shell")]
        directory: Option<PathBuf>,
        #[arg(long, help = "Open the HII desktop app after creating the terminal")]
        open: bool,
        #[arg(long, help = "Emit the created Runtime object as JSON")]
        json: bool,
    },
    #[command(about = "Create and inspect permission-scoped HII object shares")]
    #[command(hide = true)]
    Share {
        #[command(subcommand)]
        action: ShareCommand,
    },
    #[command(about = "Compile, inspect, approve, and search bounded Runtime context packs")]
    #[command(hide = true)]
    Context {
        #[command(subcommand)]
        action: ContextCommand,
    },
    #[command(about = "Inspect and use the local, source-linked Personal Mirror")]
    #[command(hide = true)]
    Mirror {
        #[command(subcommand)]
        action: MirrorCommand,
    },
    #[command(about = "Save, inspect, and restore named local canvas states")]
    #[command(hide = true)]
    State {
        #[arg(
            long,
            global = true,
            help = "Space ID; defaults to the selected local Space"
        )]
        space: Option<String>,
        #[command(subcommand)]
        action: StateCommand,
    },
    #[command(name = "apps", about = "List, register, and launch HII applications")]
    #[command(hide = true)]
    Apps {
        #[command(subcommand)]
        action: ApplicationsCommand,
    },
    #[command(about = "Preview or apply a restorable cleanup of installed HII surfaces")]
    Clean {
        #[arg(
            long,
            help = "Back up and remove the installed HII application bundles"
        )]
        apply: bool,
        #[arg(
            long,
            requires = "apply",
            help = "Confirm without an interactive prompt"
        )]
        yes: bool,
        #[arg(long, help = "Emit one machine-readable result")]
        json: bool,
    },
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
            long = "context-source",
            value_name = "SOURCE",
            help = "Source-labelled invocation context recorded in the receipt; repeatable"
        )]
        context_sources: Vec<String>,
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
            long = "skill",
            value_name = "ID",
            help = "Run with a reviewed HII skill and attribute the receipt; repeatable"
        )]
        skills: Vec<String>,
        // Named `--autonomy` until it was noticed that `--help` presented it
        // beside `--authority` as if both were enforced. Only `--authority` is:
        // this one is prose in the system prompt, so it is now named for what it
        // does — how often the model pauses to ask — and says so.
        #[arg(
            long = "asks",
            alias = "autonomy",
            value_enum,
            default_value_t = AutonomyArg::LocalFull,
            value_name = "WHEN",
            help = "How often the model should stop and ask: never | sensitive. \
                    A prompt instruction, not an enforced boundary — use --authority for that"
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
    #[command(about = "Show HII's grounded continuity, attention, and authority boundary")]
    #[command(hide = true)]
    Presence {
        #[command(subcommand)]
        action: Option<PresenceCommand>,
        #[arg(
            long,
            global = true,
            help = "Emit one machine-readable presence snapshot"
        )]
        json: bool,
    },
    #[command(about = "Check CLI, workspace, Git, HII, and provider readiness")]
    Doctor {
        #[command(subcommand)]
        action: Option<DoctorCommand>,
    },
    #[command(about = "List models advertised by the selected local runtime")]
    #[command(hide = true)]
    Models,
    #[command(about = "Show local, Codex, and Claude account access")]
    Providers,
    #[command(about = "Connect your HII account or an existing provider plan")]
    Login {
        #[arg(
            value_name = "PROVIDER",
            help = "account (default) | local | status | clear | codex | claude"
        )]
        provider: Option<String>,
        #[arg(long, value_name = "NAME", help = "Display name for `hii login local`")]
        name: Option<String>,
        #[arg(
            long,
            value_name = "EMAIL",
            help = "Optional local profile email label"
        )]
        email: Option<String>,
        #[arg(
            long,
            value_name = "NAME",
            help = "Name shown for this linked computer"
        )]
        device_name: Option<String>,
    },
    #[command(about = "Create a signed local contact card for HII Link")]
    #[command(hide = true)]
    Link {
        #[command(subcommand)]
        action: LinkCommand,
    },
    #[command(
        alias = "receipt",
        about = "Inspect the latest or selected run receipt"
    )]
    Proof {
        id: Option<String>,
        #[arg(value_name = "ARCHIVE_ID")]
        argument: Option<String>,
        #[arg(long)]
        json: bool,
        #[arg(long, help = "Preview legacy files outside current ledger limits")]
        preview: bool,
        #[arg(long, help = "Archive and replace verified oversized legacy files")]
        execute: bool,
        #[arg(long, hide = true, help = "Legacy alias for --execute")]
        repair: bool,
        #[arg(long, value_name = "ARCHIVE_ID", hide = true)]
        restore: Option<String>,
    },
    #[command(about = "Watch the continuously legible HII run stream")]
    Stream {
        #[arg(
            long,
            value_name = "ID",
            help = "Follow one run instead of the latest workspace run"
        )]
        run: Option<String>,
        #[arg(long, help = "Render existing events and exit instead of following")]
        snapshot: bool,
        #[arg(long, help = "Emit normalized agent-readable JSONL")]
        jsonl: bool,
    },
    #[command(about = "Manage enrolled Macs and PCs controlled by this HII")]
    #[command(hide = true)]
    Systems {
        #[command(subcommand)]
        action: Option<SystemsCommand>,
    },
    #[command(about = "Project CLI-owned runtime resources for HII surfaces")]
    #[command(hide = true)]
    Ecosystem {
        #[command(subcommand)]
        action: EcosystemCommand,
    },
    #[command(about = "Operate HII-owned device networking and browser pairing")]
    #[command(hide = true)]
    Network {
        #[command(subcommand)]
        action: NetworkCommand,
    },
    #[command(about = "Run a bounded command against an enrolled system")]
    #[command(hide = true)]
    On {
        #[arg(value_name = "SYSTEM")]
        system: String,
        #[command(subcommand)]
        action: OnCommand,
    },
    #[command(about = "Local kanban/todo board")]
    Board {
        #[command(subcommand)]
        action: Option<BoardCommand>,
    },
    #[command(about = "Discover and download capability sources from trusted online indexes")]
    #[command(hide = true)]
    Discover {
        #[command(subcommand)]
        action: DiscoverCommand,
    },
    #[command(about = "Skill lifecycle: proposed -> observed -> verified -> trusted")]
    #[command(hide = true)]
    Skills {
        #[command(subcommand)]
        action: SkillsCommand,
    },
    #[command(
        about = "Search every local capability HII already owns (skills, capabilities, drafts)"
    )]
    Find {
        #[arg(help = "What you want to do, in plain words; omit to summarize the index")]
        query: Vec<String>,
        #[arg(long, help = "Maximum matches to return")]
        limit: Option<usize>,
        #[arg(long, help = "Emit results as JSON")]
        json: bool,
    },
    #[command(about = "Find, capture, inspect, and export durable information objects")]
    #[command(hide = true)]
    Info {
        #[command(subcommand)]
        action: InfoCommand,
    },
    #[command(about = "Run governed web intent slices through the local browser worker")]
    #[command(hide = true)]
    Web {
        #[command(subcommand)]
        action: WebCommand,
    },
    #[command(about = "Compile intent into a capability, authority, execution, and proof plan")]
    #[command(hide = true)]
    Pipe {
        #[arg(required = true, num_args = 1.., help = "Human intent to compile")]
        intent: Vec<String>,
        #[arg(
            long,
            value_name = "LEVEL",
            help = "Authority envelope: read-only | workspace | external-preview | external-commit"
        )]
        authority: Option<String>,
        #[arg(
            long,
            value_name = "ID_OR_QUERY",
            help = "Resolve this capability while preserving INTENT as the execution goal"
        )]
        capability: Option<String>,
        #[arg(
            long,
            help = "Execute a ready typed adapter through the governed runner"
        )]
        execute: bool,
        #[arg(long, value_name = "COMMAND", help = "Deterministic acceptance check")]
        verify: Vec<String>,
        #[arg(long, value_name = "CRITERIA", help = "Completion criterion")]
        done_when: Option<String>,
        #[arg(long, help = "Emit the complete machine-readable pipe plan")]
        json: bool,
    },
    #[command(about = "Measure one shared HII loop against 20 everyday requests")]
    #[command(hide = true)]
    Usefulness {
        #[command(subcommand)]
        action: UsefulnessCommand,
    },
    #[command(
        about = "Match human or agent needs to HII-hosted services and verified fulfillment",
        hide = true
    )]
    #[command(hide = true)]
    Service {
        #[command(subcommand)]
        action: ServiceCommand,
    },
    #[command(about = "Send and inspect source-attributed agent notifications")]
    #[command(hide = true)]
    Notify {
        #[command(subcommand)]
        action: NotifyCommand,
    },
    #[command(about = "Plan, price, triage, and govern organizational and physical projects")]
    #[command(hide = true)]
    Project {
        #[command(subcommand)]
        action: ProjectCommand,
    },
    #[command(about = "Create, activate, and reconstruct objective threads")]
    #[command(hide = true)]
    Thread {
        #[command(subcommand)]
        action: ThreadCommand,
    },
    #[command(about = "Record one provider-neutral interaction proposal")]
    #[command(hide = true)]
    Interact {
        #[arg(long)]
        project: String,
        #[arg(long)]
        thread: String,
        #[arg(long)]
        interaction: Option<String>,
        #[arg(
            long,
            value_name = "JSON",
            help = "Exactly one InteractionProposalV1 JSON object"
        )]
        proposal: String,
        #[arg(
            long,
            help = "Emit the resulting event and regenerated snapshot as JSON lines"
        )]
        jsonl: bool,
    },
    #[command(about = "Manage local recurring HII work through cron")]
    #[command(hide = true)]
    Schedule {
        #[command(subcommand)]
        action: ScheduleCommand,
    },
    #[command(
        name = "tools-manifest",
        about = "Print the agent tool capability manifest (ACP/MCP boundary) as JSON"
    )]
    #[command(hide = true)]
    ToolsManifest,
    #[command(about = "Inspect and guide autonomous HII tool creation")]
    #[command(hide = true)]
    Tools {
        #[command(subcommand)]
        action: ToolsCommand,
    },
    #[command(about = "Serve HII's governed tools and canonical canvas over MCP stdio")]
    #[command(hide = true)]
    Mcp {
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
    #[command(hide = true)]
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
    #[command(
        about = "Print a shell tab-completion script for bash, zsh, fish, elvish, or powershell"
    )]
    #[command(hide = true)]
    Completions {
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
}

#[derive(Subcommand, Debug)]
enum ShareCommand {
    #[command(
        about = "Create a portable object bundle; live and publish fail closed until Network is configured"
    )]
    Create {
        #[arg(value_enum)]
        mode: ShareModeArg,
        #[arg(
            long = "object",
            value_name = "ID",
            help = "Object to include; repeatable; omit for the whole Space"
        )]
        objects: Vec<String>,
        #[arg(
            long,
            value_name = "IDENTITY",
            help = "Explicit intended recipient identity"
        )]
        recipient: Option<String>,
        #[arg(long, value_name = "FILE", help = "New .hii.json bundle path")]
        output: PathBuf,
        #[arg(long, help = "Emit the bundle and path as JSON")]
        json: bool,
    },
    #[command(about = "List locally recorded share grants and exported bundles")]
    List {
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Revoke future Network use of a share record; portable copies remain portable"
    )]
    Revoke {
        share: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum StateCommand {
    Save {
        name: String,
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Show {
        state: String,
    },
    Restore {
        state: String,
        #[arg(long, help = "Apply the previewed state; otherwise only preview")]
        apply: bool,
        #[arg(long, help = "Sequence shown in the preview; required with --apply")]
        expected_sequence: Option<u64>,
    },
    #[command(about = "Clear canvas objects after saving a recoverable state")]
    Clear,
}

#[derive(Subcommand, Debug)]
enum ContextCommand {
    #[command(about = "Compile a deterministic, source-linked context pack")]
    Compile {
        #[arg(required = true, num_args = 1..)]
        intent: Vec<String>,
        #[arg(long, default_value = "default")]
        space: String,
        #[arg(long = "selection", value_name = "OBJECT_ID")]
        selections: Vec<String>,
        #[arg(long, default_value = "plan")]
        mode: String,
        #[arg(long, default_value = "read-only")]
        authority: String,
        #[arg(long)]
        budget: Option<u64>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Inspect one frozen context pack")]
    Show {
        id: String,
        #[arg(long, help = "Require a current approved fingerprint before returning")]
        fingerprint: Option<String>,
        #[arg(long, help = "Render only the bounded model-facing context")]
        render: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Approve exactly one context-pack fingerprint")]
    Approve {
        id: String,
        fingerprint: String,
        #[arg(long, help = "Record a local read-only policy approval")]
        policy: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Search only within one frozen context pack")]
    Search {
        id: String,
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[arg(long, default_value_t = 10)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum MirrorCommand {
    #[command(about = "Inspect the local Mirror, its sources, weights, and connections")]
    Show {
        #[arg(long, value_enum, default_value_t = mirror::MirrorStrength::Balanced)]
        strength: mirror::MirrorStrength,
        #[arg(long, value_enum, default_value_t = mirror::MirrorAuthority::Answer)]
        authority: mirror::MirrorAuthority,
        #[arg(long, help = "Emit the complete source-labelled Mirror snapshot")]
        json: bool,
    },
    #[command(about = "Answer one question through the source-linked Mirror")]
    Ask {
        #[arg(required = true, num_args = 1..)]
        question: Vec<String>,
        #[arg(long, value_enum, default_value_t = mirror::MirrorStrength::Balanced)]
        strength: mirror::MirrorStrength,
        #[arg(long, value_enum, default_value_t = mirror::MirrorAuthority::Answer)]
        authority: mirror::MirrorAuthority,
        #[arg(
            long,
            conflicts_with = "jsonl",
            help = "Print one machine-readable final result"
        )]
        json: bool,
        #[arg(
            long,
            conflicts_with = "json",
            help = "Stream machine-readable run events"
        )]
        jsonl: bool,
    },
    #[command(about = "Steer the source-linked Mirror toward one bounded local goal")]
    Run {
        #[arg(required = true, num_args = 1..)]
        goal: Vec<String>,
        #[arg(long, value_enum, default_value_t = mirror::MirrorStrength::Balanced)]
        strength: mirror::MirrorStrength,
        #[arg(long, value_enum, default_value_t = mirror::MirrorAuthority::Prepare)]
        authority: mirror::MirrorAuthority,
        #[arg(
            long,
            value_name = "CRITERIA",
            help = "Completion criterion recorded in the receipt"
        )]
        done_when: Option<String>,
        #[arg(
            long,
            value_name = "COMMAND",
            help = "Deterministic local check; repeatable"
        )]
        verify: Vec<String>,
        #[arg(
            long,
            conflicts_with = "jsonl",
            help = "Print one machine-readable final result"
        )]
        json: bool,
        #[arg(
            long,
            conflicts_with = "json",
            help = "Stream machine-readable run events"
        )]
        jsonl: bool,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ShareModeArg {
    LiveReference,
    Snapshot,
    Fork,
    Publish,
    Export,
}

impl From<ShareModeArg> for hii_core::runtime::RuntimeShareModeV1 {
    fn from(value: ShareModeArg) -> Self {
        match value {
            ShareModeArg::LiveReference => Self::LiveReference,
            ShareModeArg::Snapshot => Self::Snapshot,
            ShareModeArg::Fork => Self::Fork,
            ShareModeArg::Publish => Self::Publish,
            ShareModeArg::Export => Self::Export,
        }
    }
}

#[derive(Subcommand, Debug)]
enum PresenceCommand {
    #[command(about = "Report observed runtime, model, trace, context, and proof state")]
    Status,
}

#[derive(Subcommand, Debug)]
enum ApplicationsCommand {
    #[command(alias = "ls", about = "List applications registered with HII")]
    List {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Scan the macOS Applications folders for newly installed applications")]
    Refresh {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Register an agent-made application manifest")]
    Register {
        #[arg(value_name = "MANIFEST")]
        manifest: PathBuf,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Request an application on a declared HII surface")]
    Launch {
        #[arg(value_name = "APPLICATION")]
        application: String,
        #[arg(long, default_value = "canvas")]
        surface: String,
        #[arg(long, default_value = "cli")]
        source: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List launch requests not yet handled by a surface")]
    Requests {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Acknowledge a handled application launch request")]
    Acknowledge {
        #[arg(value_name = "REQUEST")]
        request: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum LinkCommand {
    #[command(about = "Print the current signed HII contact card")]
    Card {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Initialize the HII account-bound native WireGuard control plane")]
    Init {
        #[arg(long, value_name = "ID", help = "Stable lowercase device identifier")]
        device: Option<String>,
        #[arg(long, value_name = "NAME", help = "Human-readable local device name")]
        name: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show truthful local control-plane and verified data-plane status")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Print the signed public mesh profile without private key material")]
    Profile {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Manage HII-account-approved native WireGuard peers")]
    Peer {
        #[command(subcommand)]
        action: LinkPeerCommand,
    },
    #[command(about = "Set this device's WireGuard endpoint and listen port")]
    Endpoint {
        #[arg(long, value_name = "HOST:PORT")]
        value: Option<String>,
        #[arg(long, default_value_t = 51820)]
        listen_port: u16,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Write the owner-only native WireGuard configuration")]
    Prepare {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Activate the HII mesh through the platform WireGuard runtime")]
    Up {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Deactivate the HII WireGuard interface")]
    Down {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum LinkPeerCommand {
    #[command(about = "Approve and add a native WireGuard peer to this HII account")]
    Add {
        #[arg(long, value_name = "ID")]
        device: String,
        #[arg(long, value_name = "NAME")]
        name: String,
        #[arg(long, value_name = "PLATFORM")]
        platform: String,
        #[arg(long, value_name = "BASE64")]
        public_key: String,
        #[arg(long, value_name = "HOST:PORT")]
        endpoint: Option<String>,
        #[arg(long, value_name = "SOURCE", default_value = "direct")]
        endpoint_source: String,
        #[arg(long, value_name = "PORT")]
        listen_port: Option<u16>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Revoke a peer and remove it from the native configuration")]
    Revoke {
        device: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Export an account-signed public bootstrap profile for one peer")]
    Bootstrap {
        device: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum InfoCommand {
    #[command(about = "Capture a web source with content, images, lineage, and a receipt")]
    Capture {
        url: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Search captured information or discover sources on the web")]
    Find {
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[arg(
            long,
            help = "Discover uncaptured web sources instead of searching local state"
        )]
        web: bool,
        #[arg(long, default_value_t = 10)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Inspect one source and its linked image objects")]
    Inspect {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List immutable captured versions of one source")]
    Changes {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Export a source-backed Markdown artifact with a receipt")]
    Export {
        id: String,
        #[arg(long, value_name = "PATH")]
        output: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum UsefulnessCommand {
    #[command(about = "Run or validate the 20-request usefulness benchmark")]
    Benchmark {
        #[arg(long, help = "Validate the declarative suite without invoking a model")]
        validate_only: bool,
        #[arg(long, value_name = "ID", help = "Run or validate one benchmark case")]
        case: Option<String>,
        #[arg(
            long,
            default_value_t = 14,
            help = "Tool-step ceiling for each request"
        )]
        max_steps: usize,
        #[arg(
            long,
            default_value_t = 90,
            help = "Wall-clock ceiling in seconds for each request"
        )]
        deadline_secs: u64,
        #[arg(long, help = "Emit a machine-readable validation or benchmark report")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum WebCommand {
    #[command(
        name = "vertical-test",
        about = "Prove the deterministic browser intent loop"
    )]
    VerticalTest {
        #[arg(long)]
        url: String,
        #[arg(long, value_name = "PATH")]
        browserd: PathBuf,
        #[arg(long)]
        require_approval: bool,
        #[arg(long, requires = "require_approval")]
        approve: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum NotifyCommand {
    #[command(about = "Send one event to the HII canvas and requested owned-device routes")]
    Send {
        #[arg(long)]
        title: String,
        #[arg(required = true, num_args = 1..)]
        message: Vec<String>,
        #[arg(long, default_value = "agent")]
        source: String,
        #[arg(long, default_value = "info")]
        severity: String,
        #[arg(long)]
        coordinate: Option<String>,
        #[arg(long = "route")]
        routes: Vec<String>,
        #[arg(long = "proof")]
        proof_refs: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "List the shared HII notification inbox")]
    List {
        #[arg(long)]
        unread: bool,
        #[arg(long, default_value_t = 40)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Mark one notification read")]
    Read {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ServiceCommand {
    #[command(about = "List capabilities exposed as local service offers")]
    Offers {
        #[arg(help = "Optional need or capability query")]
        query: Vec<String>,
        #[arg(long, help = "Maximum service offers to return")]
        limit: Option<usize>,
        #[arg(long, help = "Emit the typed service catalog as JSON")]
        json: bool,
    },
    #[command(about = "Record a need with authority, success, service, and proof contracts")]
    Request {
        #[arg(required = true, num_args = 1.., help = "Human or agent need")]
        need: Vec<String>,
        #[arg(
            long,
            value_name = "ID_OR_QUERY",
            help = "Select a capability while preserving NEED as the requested outcome"
        )]
        capability: Option<String>,
        #[arg(
            long,
            value_name = "LEVEL",
            help = "Authority envelope: read-only | workspace | external-preview | external-commit"
        )]
        authority: Option<String>,
        #[arg(
            long,
            value_name = "CRITERIA",
            help = "Required success condition for fulfillment"
        )]
        done_when: String,
        #[arg(
            long,
            value_name = "EVIDENCE",
            help = "Required fulfillment evidence; repeat for multiple proof obligations"
        )]
        proof: Vec<String>,
        #[arg(long, help = "Emit the typed service request as JSON")]
        json: bool,
    },
    #[command(alias = "ls", about = "List durable local service requests")]
    Requests {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Inspect one durable service request")]
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Fulfill a ready request through the governed HII runner")]
    Fulfill {
        id: String,
        #[arg(
            long,
            value_name = "COMMAND",
            help = "Deterministic acceptance check; repeat for multiple checks"
        )]
        verify: Vec<String>,
        #[arg(long, help = "Emit the updated request and receipt link as JSON")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ProjectCommand {
    #[command(about = "Bind a computational project root to HII authority")]
    Bind {
        #[arg(default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Create a governed project using the architecture delivery profile")]
    Create {
        #[arg(required = true, num_args = 1..)]
        name: Vec<String>,
        #[arg(long, default_value = "architecture")]
        project_type: String,
        #[arg(long)]
        location: Option<String>,
        #[arg(long, default_value = "USD")]
        currency: String,
        #[arg(long, value_name = "AMOUNT")]
        budget: Option<String>,
        #[arg(
            long,
            help = "Explicit total professional hours for the coordinated baseline option"
        )]
        base_hours: u64,
        #[arg(
            long,
            value_name = "AMOUNT",
            help = "Explicit loaded blended hourly rate; no market rate is assumed"
        )]
        blended_rate: String,
        #[arg(long, default_value = "0", value_name = "AMOUNT")]
        consultant_allowance: String,
        #[arg(long, default_value = "0", value_name = "AMOUNT")]
        direct_costs: String,
        #[arg(
            long,
            default_value_t = 1_000,
            help = "Planning contingency in basis points"
        )]
        contingency_bps: u32,
        #[arg(
            long,
            default_value_t = 0,
            help = "Fee markup or overhead adjustment in basis points"
        )]
        markup_bps: u32,
        #[arg(long, default_value_t = 36)]
        total_weeks: u32,
        #[arg(long, default_value_t = 3)]
        options: usize,
        #[arg(long)]
        json: bool,
    },
    #[command(alias = "ls", about = "List local HII projects")]
    List {
        #[arg(long, help = "Preserve the prior detailed delivery-project listing")]
        delivery: bool,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Revalidate filesystem and optional Git identity")]
    Validate {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show a project, delivery prices, KPIs, and next actions")]
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Recalculate SD, DD, CD, and active-development delivery options")]
    Price {
        id: String,
        #[arg(long)]
        base_hours: Option<u64>,
        #[arg(long, value_name = "AMOUNT")]
        blended_rate: Option<String>,
        #[arg(long, value_name = "AMOUNT")]
        consultant_allowance: Option<String>,
        #[arg(long, value_name = "AMOUNT")]
        direct_costs: Option<String>,
        #[arg(long)]
        contingency_bps: Option<u32>,
        #[arg(long)]
        markup_bps: Option<u32>,
        #[arg(long)]
        total_weeks: Option<u32>,
        #[arg(long)]
        options: Option<usize>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Triage KPIs, budget coverage, stakeholder questions, suppliers, and next tasks"
    )]
    Triage {
        id: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "stakeholder-add",
        about = "Add a stakeholder and their decision boundary"
    )]
    StakeholderAdd {
        id: String,
        name: String,
        #[arg(long)]
        role: String,
        #[arg(long)]
        decision_scope: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "kpi-add",
        about = "Add an organization-specific KPI definition"
    )]
    KpiAdd {
        id: String,
        name: String,
        #[arg(long)]
        unit: String,
        #[arg(long)]
        target: String,
        #[arg(long)]
        calculation: String,
        #[arg(long, default_value = "project manager")]
        owner: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "kpi-update",
        about = "Record a KPI reading with source evidence"
    )]
    KpiUpdate {
        id: String,
        kpi: String,
        value: String,
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long = "by", default_value = "local operator")]
        actor: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "task-add",
        about = "Add a KPI-linked task to the dependency graph"
    )]
    TaskAdd {
        id: String,
        #[arg(required = true, num_args = 1..)]
        title: Vec<String>,
        #[arg(long)]
        phase: String,
        #[arg(long, default_value = "project-management")]
        system: String,
        #[arg(long, default_value = "project team")]
        owner: String,
        #[arg(long = "depends-on")]
        depends_on: Vec<String>,
        #[arg(long = "kpi")]
        kpis: Vec<String>,
        #[arg(long = "budget-line")]
        budget_lines: Vec<String>,
        #[arg(long = "evidence")]
        evidence_required: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Select and record approval of one delivery option")]
    Select {
        id: String,
        option: String,
        #[arg(long = "by")]
        actor: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "task-complete",
        about = "Complete a dependency-ready task with evidence"
    )]
    TaskComplete {
        id: String,
        task: String,
        #[arg(long = "evidence", required = true)]
        evidence: Vec<String>,
        #[arg(long = "by", default_value = "local operator")]
        actor: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "question-add",
        about = "Add a stakeholder or shareholder question"
    )]
    QuestionAdd {
        id: String,
        #[arg(required = true, num_args = 1..)]
        question: Vec<String>,
        #[arg(long, default_value = "project stakeholder")]
        asked_by: String,
        #[arg(long, default_value = "project manager")]
        owner: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "question-answer",
        about = "Answer a project question with optional source evidence"
    )]
    QuestionAnswer {
        id: String,
        question: String,
        #[arg(required = true, num_args = 1..)]
        answer: Vec<String>,
        #[arg(long = "source")]
        sources: Vec<String>,
        #[arg(long = "by", default_value = "local operator")]
        actor: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "supplier-add",
        about = "Add a source-linked supplier candidate to a project need"
    )]
    SupplierAdd {
        id: String,
        need: String,
        name: String,
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        contact: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "supplier-search",
        about = "Search public sources for supplier candidates without contacting them"
    )]
    SupplierSearch {
        id: String,
        need: String,
        #[arg(long, default_value_t = 8)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    #[command(
        name = "supplier-quote",
        about = "Record a supplier quote and update the linked budget forecast"
    )]
    SupplierQuote {
        id: String,
        need: String,
        supplier: String,
        amount: String,
        #[arg(long, required = true)]
        source: String,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Generate an unsent supplier request-for-quote draft")]
    Rfq { id: String, need: String },
    #[command(
        name = "phase-approve",
        about = "Approve the current phase for the current project revision"
    )]
    PhaseApprove {
        id: String,
        phase: String,
        #[arg(long = "by")]
        actor: String,
        #[arg(long, required = true)]
        note: String,
        #[arg(long)]
        json: bool,
    },
    #[command(
        about = "Advance only after option, task evidence, and revision-scoped phase approval gates pass"
    )]
    Advance {
        id: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ThreadCommand {
    Create {
        #[arg(long)]
        project: String,
        #[arg(required=true,num_args=1..)]
        objective: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(alias = "ls")]
    List {
        #[arg(long)]
        project: String,
        #[arg(long)]
        json: bool,
    },
    Activate {
        #[arg(long)]
        project: String,
        thread: String,
        #[arg(long)]
        json: bool,
    },
    Show {
        thread: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum SystemsCommand {
    #[command(about = "Register a machine as a bounded HII executor")]
    Enroll {
        #[arg(value_name = "ID")]
        id: String,
        #[arg(long, value_name = "HOST")]
        host: Option<String>,
        #[arg(long, value_name = "OS", help = "macos | windows | linux | unknown")]
        os: Option<String>,
        #[arg(
            long,
            value_name = "TRANSPORT",
            default_value = "tailscale-ssh",
            help = "tailscale-ssh | ssh | local | manual"
        )]
        transport: String,
        #[arg(
            long = "cap",
            value_name = "CAPABILITY",
            help = "Capability this executor advertises; repeatable"
        )]
        capabilities: Vec<String>,
        #[arg(long, help = "Mark this executor as the local machine")]
        local: bool,
        #[arg(long, help = "Emit the enrolled machine as JSON")]
        json: bool,
    },
    #[command(alias = "ls", about = "List enrolled machines")]
    List {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show executor readiness for enrolled machines")]
    Status {
        #[arg(value_name = "SYSTEM")]
        system: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum EcosystemCommand {
    #[command(about = "Emit a bounded, source-linked runtime resource catalog")]
    Catalog {
        #[arg(long, help = "Emit the catalog as JSON")]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum NetworkCommand {
    #[command(about = "Create or inspect the private HII development certificate")]
    Certificate {
        #[command(subcommand)]
        action: NetworkCertificateCommand,
    },
    #[command(about = "Create one short-lived browser pairing URL")]
    Pair {
        #[arg(long, default_value_t = 300, value_name = "SECONDS")]
        ttl: u64,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Start the private HII HTTPS gateway in the background")]
    Start {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Run the HII HTTPS gateway in the foreground", hide = true)]
    Serve,
    #[command(about = "Stop the owned HII HTTPS gateway")]
    Stop {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show configured routes without inferring connectivity")]
    Status {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Check certificates, local canvas, and route configuration")]
    Doctor {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum NetworkCertificateCommand {
    #[command(about = "Create a removable 30-day development trust profile")]
    Create {
        #[arg(
            long = "host",
            value_name = "HOST",
            help = "Additional DNS name or IP; repeatable"
        )]
        hosts: Vec<String>,
        #[arg(long, default_value_t = 7443)]
        port: u16,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum OnCommand {
    #[command(about = "Call the installed HII CLI over authenticated SSH and save a receipt")]
    Cli {
        #[arg(
            long,
            help = "Explicitly authorize this invocation to change remote state"
        )]
        allow_write: bool,
        #[arg(long, default_value_t = 120)]
        timeout: u64,
        #[arg(long)]
        json: bool,
        #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    #[command(about = "Run a shell command on an enrolled executor")]
    Run {
        #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
        #[arg(long, value_name = "PATH")]
        cwd: Option<String>,
        #[arg(long, help = "Emit the dispatch plan as JSON")]
        json: bool,
    },
    #[command(about = "Inspect files on an enrolled executor")]
    Files {
        #[command(subcommand)]
        action: OnFilesCommand,
    },
    #[command(about = "Inspect visible apps on an enrolled executor")]
    Apps {
        #[command(subcommand)]
        action: OnAppsCommand,
    },
    #[command(about = "Inspect receipts produced by an enrolled executor")]
    Proof {
        #[arg(value_name = "ID")]
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum OnFilesCommand {
    #[command(alias = "list", about = "List a directory on an enrolled executor")]
    Ls {
        #[arg(value_name = "PATH", default_value = ".")]
        path: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum OnAppsCommand {
    #[command(alias = "ls", about = "List foreground applications or windows")]
    List {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand, Debug)]
enum ToolsCommand {
    #[command(about = "Show recent autonomous tool activity")]
    Activity {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show current canonical tool registry")]
    Registry {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Show draft tool proposals")]
    Drafts {
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Create a draft tool proposal from observed need")]
    Propose {
        #[arg(required = true, num_args = 1..)]
        intent: Vec<String>,
        #[arg(long)]
        read_only: bool,
        #[arg(long)]
        authority: Option<String>,
        #[arg(long)]
        json: bool,
    },
    #[command(about = "Record scaffold readiness for a draft tool")]
    Scaffold { id: String },
    #[command(about = "Record test proof for a draft tool")]
    Test { id: String },
    #[command(about = "Promote a proven draft within current authority")]
    Promote {
        id: String,
        #[arg(long, help = "Required for tools that expand authority")]
        approved: bool,
    },
    #[command(about = "Summarize observed tool needs")]
    Observe {
        #[arg(long)]
        json: bool,
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
enum SkillsCommand {
    #[command(about = "Show every tracked skill and the state its evidence supports")]
    Lifecycle {
        #[arg(long, help = "Emit the full lifecycle as JSON")]
        json: bool,
    },
    #[command(
        about = "Explicitly promote a skill, overriding its earned evidence (competence only, never authority)"
    )]
    Promote {
        id: String,
        #[arg(long, help = "Why this override is warranted")]
        reason: Option<String>,
    },
    #[command(
        name = "record-use",
        about = "Attribute a skill invocation to the current run; call this where the skill is invoked"
    )]
    RecordUse {
        id: String,
        #[arg(
            long,
            value_name = "ID",
            help = "Receipt to attribute to, when outside a run"
        )]
        receipt: Option<String>,
    },
    #[command(about = "Execute a reviewed skill through the governed HII agent loop")]
    Run {
        id: String,
        #[arg(required = true, num_args = 1.., help = "Goal to execute with the skill")]
        goal: Vec<String>,
        #[arg(long, value_name = "COMMAND", help = "Deterministic acceptance check")]
        verify: Vec<String>,
        #[arg(long, value_name = "CRITERIA", help = "Completion criterion")]
        done_when: Option<String>,
    },
    #[command(about = "Explicitly reject a skill regardless of how well it has performed")]
    Reject {
        id: String,
        #[arg(long, help = "Why this skill is being rejected")]
        reason: Option<String>,
    },
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
    /// Pause before sensitive, destructive, or external actions.
    #[value(name = "sensitive", alias = "approval")]
    Approval,
    /// Act without pausing; `--authority` remains the boundary that is enforced.
    #[default]
    #[value(name = "never", alias = "local-full")]
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
    // `--help` shows the core surface only; the full 77-command table lives here
    // so that neither listing can drift from what actually routes.
    if wants_full_command_list(&raw[1..]) {
        println!("{}", route::full_command_list());
        return ExitCode::SUCCESS;
    }
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
        Some(Commands::Memory { action }) => {
            memory::execute(action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::SessionBackup { action }) => {
            session_backup::execute(action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Chat { action }) => {
            local_chat::execute(action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Ask {
            prompt,
            sources,
            jsonl,
        }) => {
            ask::run(
                &paths,
                cli.model.as_deref(),
                prompt.join(" "),
                sources,
                cli.cwd.as_deref(),
                jsonl,
            )?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Terminal {
            directory,
            open,
            json,
        }) => {
            create_space_terminal(directory.or(cli.cwd), open, json)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Share { action }) => {
            share_command(action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Context { action }) => {
            context_command(&paths, cli.cwd, action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Mirror { action }) => {
            let workspace = workspace(cli.cwd.clone())?;
            let (intent, strength, authority, done_when, verify, outcome_requirements, json, jsonl) =
                match action {
                    MirrorCommand::Show {
                        strength,
                        authority,
                        json,
                    } => {
                        let snapshot = mirror::inspect(&paths, &workspace, strength, authority);
                        println!("{}", mirror::render(&snapshot, json)?);
                        return Ok(ExitCode::SUCCESS);
                    }
                    MirrorCommand::Ask {
                        question,
                        strength,
                        authority,
                        json,
                        jsonl,
                    } => (
                        question.join(" "),
                        strength,
                        authority,
                        Some("a final answer is returned; verification is not claimed".into()),
                        Vec::new(),
                        Some(contract::OutcomeRequirements::informational_response()),
                        json,
                        jsonl,
                    ),
                    MirrorCommand::Run {
                        goal,
                        strength,
                        authority,
                        done_when,
                        verify,
                        json,
                        jsonl,
                    } => (
                        goal.join(" "),
                        strength,
                        authority,
                        done_when,
                        verify,
                        None,
                        json,
                        jsonl,
                    ),
                };
            if ModelProvider::discover(&AppPaths::model_url()) == ModelProvider::OxAlphaWeb {
                return Err("Personal Mirror runs require a local HII model provider; select HII Native, Ollama, LM Studio, or a private local-network runtime".into());
            }
            let snapshot = mirror::inspect(&paths, &workspace, strength, authority);
            let mut context_sources = if strength.uses_personal_context() {
                snapshot.source_refs()
            } else {
                Vec::new()
            };
            context_sources.push(format!("hii-mirror:strength={}", strength.label()));
            context_sources.push(format!("hii-mirror:authority={}", authority.label()));
            let receipt = agent::run(
                &paths,
                RunOptions {
                    goal: intent,
                    workspace,
                    model: cli.model,
                    review: false,
                    review_model: None,
                    max_steps: cli.max_steps,
                    dry_run: authority.is_read_only(),
                    verbose: false,
                    authority: authority.execution_authority(),
                    done_when,
                    verify,
                    outcome_requirements,
                    use_context: strength.uses_personal_context(),
                    context_sources,
                    system_context: vec![snapshot.system_context()],
                    output: if jsonl {
                        RunOutput::Jsonl
                    } else if json {
                        RunOutput::Json
                    } else {
                        RunOutput::Human
                    },
                    stream: StreamPolicy::Auto,
                    allow_missing_verify_deps: false,
                    budgets: Budgets {
                        max_steps: cli.max_steps,
                        max_tokens: cli.token_budget,
                        wall_clock: match cli.deadline.as_deref() {
                            Some(value) => parse_duration(value)?,
                            None => Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
                        },
                        ..Budgets::default()
                    },
                    last_message: None,
                    hooks: lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
                    coding: false,
                    skill_ids: Vec::new(),
                    autonomy_level: AutonomyLevel::LocalFull,
                },
            )?;
            Ok(ExitCode::from(receipt.exit_code))
        }
        Some(Commands::State { space, action }) => {
            state_command(space, action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Apps { action }) => {
            match action {
                ApplicationsCommand::List { json } => applications::render_list(&paths, json)?,
                ApplicationsCommand::Refresh { json } => {
                    applications::render_refresh(&paths, json)?
                }
                ApplicationsCommand::Register { manifest, json } => {
                    applications::render_register(&paths, &manifest, json)?
                }
                ApplicationsCommand::Launch {
                    application,
                    surface,
                    source,
                    json,
                } => applications::render_launch(&paths, &application, &surface, &source, json)?,
                ApplicationsCommand::Requests { json } => {
                    applications::render_requests(&paths, json)?
                }
                ApplicationsCommand::Acknowledge { request, json } => {
                    applications::render_acknowledge(&paths, &request, json)?
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Clean { apply, yes, json }) => {
            let clean_paths = clean::CleanPaths::installed_hii()?;
            if !apply {
                clean::render(&clean::preview(&clean_paths)?, json)?;
                return Ok(ExitCode::SUCCESS);
            }
            if !yes {
                if json || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                    return Err("automation must use `hii clean --apply --yes --json`".into());
                }
                let preview = clean::preview(&clean_paths)?;
                clean::render(&preview, false)?;
                print!("\nBack up and remove these installed app bundles? [y/N] ");
                io::stdout().flush().map_err(|error| error.to_string())?;
                let mut response = String::new();
                io::stdin()
                    .read_line(&mut response)
                    .map_err(|error| error.to_string())?;
                if !matches!(response.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                    println!("Cancelled. Nothing changed.");
                    return Ok(ExitCode::SUCCESS);
                }
            }
            clean::render(&clean::apply(&clean_paths, true)?, json)?;
            Ok(ExitCode::SUCCESS)
        }
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
            context_sources,
            json,
            jsonl,
            quiet,
            stream,
            allow_missing_verify_deps,
            coding,
            skills,
            autonomy,
            last_message,
        }) => {
            let workspace = workspace(cli.cwd.clone())?;
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
                    context_sources,
                    system_context: Vec::new(),
                    output,
                    stream,
                    allow_missing_verify_deps,
                    budgets: Budgets {
                        max_steps: cli.max_steps,
                        max_tokens: cli.token_budget,
                        wall_clock: match cli.deadline.as_deref() {
                            Some(value) => parse_duration(value)?,
                            None => Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
                        },
                        ..Budgets::default()
                    },
                    last_message,
                    hooks: lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
                    coding,
                    skill_ids: skills,
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
        Some(Commands::Presence { action: _, json }) => {
            let workspace = workspace(cli.cwd.clone())?;
            presence::show(&paths, &workspace, json)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Doctor { action }) => match action {
            Some(DoctorCommand::Interactive { real }) => run_interactive_doctor(&paths, real),
            None => {
                let ok = doctor(&paths, cli.cwd)?;
                Ok(if ok {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        },
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
        Some(Commands::Login {
            provider,
            name,
            email,
            device_name,
        }) => {
            println!(
                "{}",
                login_command(
                    &paths,
                    provider.as_deref(),
                    name.as_deref(),
                    email.as_deref(),
                    device_name.as_deref(),
                )?
            );
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Link { action }) => {
            match action {
                LinkCommand::Card { json } => {
                    let card = identity::IdentityStore::open(&paths).contact_card()?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&card)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "HII contact card\nname: {}\nid: {}\npublic key: {}",
                            card.name, card.id, card.public_key
                        );
                    }
                }
                LinkCommand::Init { device, name, json } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let account = identity.current()?.ok_or(
                        "No local HII account. Run `hii login local --name <name>` first.",
                    )?;
                    let device = device.unwrap_or_else(|| format!("local-{}", env::consts::OS));
                    let name =
                        name.unwrap_or_else(|| format!("{} {}", account.name, env::consts::OS));
                    let state = vpn::VpnStore::open(&paths).init(&identity, &device, &name)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&state)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "HII native WireGuard control plane ready\naccount    {}\nmesh       {}\ndevice     {} ({})\naddress    {}\nphase      {:?}\ndata plane not live — no verified peer handshake",
                            state.account_id,
                            state.mesh_id,
                            state.local_device.display_name,
                            state.local_device.device_id,
                            state.local_device.ipv4,
                            state.phase
                        );
                    }
                }
                LinkCommand::Status { json } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let status = vpn::VpnStore::open(&paths).status(&identity)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&status)
                                .map_err(|error| error.to_string())?
                        );
                    } else if !status.initialized {
                        println!("HII VPN is not initialized.\nnext: {}", status.next);
                    } else {
                        println!(
                            "HII native WireGuard\naccount       {}\nmesh          {}\ncontrol plane {}\nnative runtime {}\ninterface     {}\ndata plane    {}\nnext          {}",
                            status.account_id.as_deref().unwrap_or("unknown"),
                            status.mesh_id.as_deref().unwrap_or("unknown"),
                            if status.control_plane_ready { "ready" } else { "blocked" },
                            if status.native_wireguard.available { "available" } else { "missing" },
                            if status.native_wireguard.active { "active" } else { "inactive" },
                            if status.data_plane_live { "verified live" } else { "not live" },
                            status.next
                        );
                        for reason in status.reasons {
                            println!("note          {reason}");
                        }
                    }
                }
                LinkCommand::Profile { json } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let state = vpn::VpnStore::open(&paths).load(&identity)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&state)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "HII VPN signed public profile\naccount  {}\nmesh     {}\ndevice   {}\npublic   {}\nphase    {:?}",
                            state.account_id,
                            state.mesh_id,
                            state.local_device.device_id,
                            state.local_device.wireguard_public_key,
                            state.phase
                        );
                    }
                }
                LinkCommand::Peer { action } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let vpn = vpn::VpnStore::open(&paths);
                    match action {
                        LinkPeerCommand::Add {
                            device,
                            name,
                            platform,
                            public_key,
                            endpoint,
                            endpoint_source,
                            listen_port,
                            json,
                        } => {
                            let state = vpn.add_peer(
                                &identity,
                                &device,
                                &name,
                                &platform,
                                &public_key,
                                endpoint.as_deref(),
                                endpoint.as_ref().map(|_| endpoint_source.as_str()),
                                listen_port,
                            )?;
                            if json {
                                println!(
                                    "{}",
                                    serde_json::to_string_pretty(&state)
                                        .map_err(|error| error.to_string())?
                                );
                            } else {
                                let peer = state
                                    .peers
                                    .iter()
                                    .find(|peer| peer.device_id == device)
                                    .ok_or(
                                        "The enrolled WireGuard peer is missing from HII state.",
                                    )?;
                                println!(
                                    "HII WireGuard peer approved\ndevice   {} ({})\nplatform {}\naddress  {}\nendpoint {}\nsource   {}\ntrust    epoch {}",
                                    peer.display_name,
                                    peer.device_id,
                                    peer.platform,
                                    peer.ipv4,
                                    peer.endpoint.as_deref().unwrap_or("roaming/passive"),
                                    peer.endpoint_source.as_deref().unwrap_or("none"),
                                    state.trust_epoch
                                );
                            }
                        }
                        LinkPeerCommand::Revoke { device, json } => {
                            let state = vpn.revoke_peer(&identity, &device)?;
                            if json {
                                println!(
                                    "{}",
                                    serde_json::to_string_pretty(&state)
                                        .map_err(|error| error.to_string())?
                                );
                            } else {
                                println!(
                                    "HII WireGuard peer `{device}` revoked at trust epoch {}.",
                                    state.trust_epoch
                                );
                            }
                        }
                        LinkPeerCommand::Bootstrap { device, json } => {
                            let profile = vpn.peer_bootstrap_profile(&identity, &device)?;
                            if json {
                                println!(
                                    "{}",
                                    serde_json::to_string_pretty(&profile)
                                        .map_err(|error| error.to_string())?
                                );
                            } else {
                                println!(
                                    "HII WireGuard bootstrap profile\naccount  {}\nmesh     {}\ntarget   {} ({})\naddress  {}\npeer     {}\nsigned   yes",
                                    profile.account_id,
                                    profile.mesh_id,
                                    profile.target_device.display_name,
                                    profile.target_device.device_id,
                                    profile.target_device.ipv4,
                                    profile.mesh_peer.device_id
                                );
                            }
                        }
                    }
                }
                LinkCommand::Endpoint {
                    value,
                    listen_port,
                    json,
                } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let state = vpn::VpnStore::open(&paths).configure_local_endpoint(
                        &identity,
                        value.as_deref(),
                        listen_port,
                    )?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&state.local_device)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "HII WireGuard local endpoint\ndevice      {}\nlisten port {}\nendpoint    {}",
                            state.local_device.device_id,
                            listen_port,
                            state.local_device.endpoint.as_deref().unwrap_or("roaming/private")
                        );
                    }
                }
                LinkCommand::Prepare { json } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let native = vpn::VpnStore::open(&paths).prepare_native(&identity)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&native)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "Native WireGuard configuration ready\nbackend   {}\ninterface {}\nruntime   {}",
                            native.backend,
                            native.interface_name,
                            if native.available { "available" } else { "missing" }
                        );
                    }
                }
                LinkCommand::Up { json } => {
                    let identity = identity::IdentityStore::open(&paths);
                    let native = vpn::VpnStore::open(&paths).native_up(&identity)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&native)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "Native WireGuard interface {} is {}.",
                            native.interface_name,
                            if native.active {
                                "active"
                            } else {
                                "not active"
                            }
                        );
                    }
                }
                LinkCommand::Down { json } => {
                    let native = vpn::VpnStore::open(&paths).native_down()?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&native)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "Native WireGuard interface {} is down.",
                            native.interface_name
                        );
                    }
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Proof {
            id,
            argument,
            json,
            preview,
            execute,
            repair,
            restore,
        }) => {
            let action = id.as_deref();
            if matches!(action, Some("audit" | "archive-legacy" | "restore-legacy")) {
                let report = match action {
                    Some("restore-legacy") => {
                        let archive_id = argument
                            .as_deref()
                            .or(restore.as_deref())
                            .ok_or("usage: hii proof restore-legacy <surface/run-id>")?;
                        ledger_audit::restore(&paths.runtime, archive_id)?;
                        ledger_audit::audit(&paths.runtime, false)?
                    }
                    Some("archive-legacy") => {
                        if preview && (execute || repair) {
                            return Err("choose either --preview or --execute".into());
                        }
                        if !preview && !execute && !repair {
                            return Err(
                                "usage: hii proof archive-legacy --preview|--execute".into()
                            );
                        }
                        ledger_audit::audit(&paths.runtime, execute || repair)?
                    }
                    Some("audit") => {
                        if let Some(archive_id) = restore.as_deref() {
                            ledger_audit::restore(&paths.runtime, archive_id)?;
                        }
                        ledger_audit::audit(&paths.runtime, execute || repair)?
                    }
                    _ => unreachable!(),
                };
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                    );
                } else {
                    ledger_audit::print_report(&report);
                }
                return Ok(ExitCode::SUCCESS);
            }
            if argument.is_some() || preview || execute || repair || restore.is_some() {
                return Err("archive flags require `hii proof archive-legacy` or `hii proof restore-legacy`".into());
            }
            let workspace = workspace(cli.cwd.clone())?;
            proof(&paths, &workspace, id.as_deref(), json)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Stream {
            run,
            snapshot,
            jsonl,
        }) => {
            let workspace = workspace(cli.cwd.clone())?;
            stream::watch(&paths.runtime, &workspace, run.as_deref(), !snapshot, jsonl)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Systems { action }) => systems_command(&paths, action),
        Some(Commands::Ecosystem { action }) => match action {
            EcosystemCommand::Catalog { json: true } => {
                println!("{}", ecosystem_catalog::render_json(&paths.runtime)?);
                Ok(ExitCode::SUCCESS)
            }
            EcosystemCommand::Catalog { json: false } => {
                Err("`hii ecosystem catalog` requires --json".to_string())
            }
        },
        Some(Commands::Network { action }) => network_command(&paths, action),
        Some(Commands::On { system, action }) => on_command(&paths, &system, action),
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
        Some(Commands::Skills { action }) => {
            match action {
                SkillsCommand::Lifecycle { json } => {
                    println!("{}", skill_lifecycle::status(&paths, json)?)
                }
                SkillsCommand::Promote { id, reason } => {
                    println!(
                        "{}",
                        skill_lifecycle::promote(&paths, &id, reason.as_deref())?
                    )
                }
                SkillsCommand::RecordUse { id, receipt } => println!(
                    "{}",
                    skill_lifecycle::record_invocation(&paths, &id, receipt.as_deref())?
                ),
                SkillsCommand::Run {
                    id,
                    goal,
                    verify,
                    done_when,
                } => {
                    let workspace = workspace(cli.cwd.clone())?;
                    let receipt = agent::run(
                        &paths,
                        RunOptions {
                            goal: goal.join(" "),
                            workspace,
                            model: cli.model.clone(),
                            review: false,
                            review_model: None,
                            max_steps: cli.max_steps,
                            dry_run: false,
                            verbose: false,
                            authority: contract::Authority::Workspace,
                            done_when,
                            verify,
                            outcome_requirements: None,
                            use_context: true,
                            context_sources: Vec::new(),
                            system_context: Vec::new(),
                            output: RunOutput::Human,
                            stream: StreamPolicy::Auto,
                            allow_missing_verify_deps: false,
                            budgets: Budgets {
                                max_steps: cli.max_steps,
                                max_tokens: cli.token_budget,
                                wall_clock: match cli.deadline.as_deref() {
                                    Some(value) => parse_duration(value)?,
                                    None => Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
                                },
                                ..Budgets::default()
                            },
                            last_message: None,
                            hooks: lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
                            coding: true,
                            skill_ids: vec![id],
                            autonomy_level: AutonomyLevel::LocalFull,
                        },
                    )?;
                    return Ok(ExitCode::from(receipt.exit_code));
                }
                SkillsCommand::Reject { id, reason } => {
                    println!(
                        "{}",
                        skill_lifecycle::reject(&paths, &id, reason.as_deref())?
                    )
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Find { query, limit, json }) => {
            let query = query.join(" ");
            if query.trim().is_empty() {
                capability_index::summary(&paths, json)?;
            } else {
                capability_index::find(&paths, &query, limit, json)?;
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Info { action }) => {
            let workspace = workspace(cli.cwd.clone())?;
            information_command(&paths, &workspace, action)?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Web { action }) => {
            match action {
                WebCommand::VerticalTest {
                    url,
                    browserd,
                    require_approval,
                    approve,
                    json,
                } => web_cmd::vertical_test(
                    &paths,
                    &url,
                    &browserd,
                    require_approval,
                    approve,
                    json,
                )?,
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Notify { action }) => {
            match action {
                NotifyCommand::Send {
                    title,
                    message,
                    source,
                    severity,
                    coordinate,
                    routes,
                    proof_refs,
                    json,
                } => notification::send(
                    &paths,
                    &title,
                    &message.join(" "),
                    &source,
                    &severity,
                    coordinate.as_deref(),
                    &routes,
                    &proof_refs,
                    json,
                )?,
                NotifyCommand::List {
                    unread,
                    limit,
                    json,
                } => notification::list(&paths, unread, limit, json)?,
                NotifyCommand::Read { id, json } => notification::read(&paths, &id, json)?,
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Pipe {
            intent,
            authority,
            capability,
            execute,
            verify,
            done_when,
            json,
        }) => {
            let authority =
                resolve_authority(false, authority.as_deref(), AuthorityContext::Operator)?;
            let intent = intent.join(" ");
            let plan = pipe::compile_for(
                &paths,
                &intent,
                capability.as_deref().unwrap_or(&intent),
                authority,
            );
            println!("{}", pipe::render(&plan, json)?);
            if execute {
                use capability_resolver::InvocationAdapter;
                if plan.status != pipe::PipeStatus::Ready {
                    return Err(format!("pipe is {:?}: {}", plan.status, plan.next));
                }
                let skill_ids = match plan.capability.adapter.clone() {
                    Some(InvocationAdapter::WorkspaceRun) => Vec::new(),
                    Some(InvocationAdapter::SkillRun { skill_id }) => vec![skill_id],
                    None => {
                        return Err("resolved capability has no typed invocation adapter".into())
                    }
                };
                let workspace = workspace(cli.cwd.clone())?;
                let receipt = agent::run(
                    &paths,
                    RunOptions {
                        goal: intent,
                        workspace,
                        model: cli.model.clone(),
                        review: false,
                        review_model: None,
                        max_steps: cli.max_steps,
                        dry_run: false,
                        verbose: false,
                        authority,
                        done_when,
                        verify,
                        outcome_requirements: None,
                        use_context: true,
                        context_sources: Vec::new(),
                        system_context: Vec::new(),
                        output: if json {
                            RunOutput::Json
                        } else {
                            RunOutput::Human
                        },
                        stream: StreamPolicy::Auto,
                        allow_missing_verify_deps: false,
                        budgets: Budgets {
                            max_steps: cli.max_steps,
                            max_tokens: cli.token_budget,
                            wall_clock: match cli.deadline.as_deref() {
                                Some(value) => parse_duration(value)?,
                                None => Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
                            },
                            ..Budgets::default()
                        },
                        last_message: None,
                        hooks: lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
                        coding: true,
                        skill_ids,
                        autonomy_level: AutonomyLevel::LocalFull,
                    },
                )?;
                return Ok(ExitCode::from(receipt.exit_code));
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Usefulness { action }) => match action {
            UsefulnessCommand::Benchmark {
                validate_only,
                case,
                max_steps,
                deadline_secs,
                json,
            } => {
                if validate_only {
                    let validation = usefulness::validate_only(case.as_deref())?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&validation)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!(
                            "HII usefulness benchmark\nvalid      yes\nsuite      {}\ncases      {}",
                            validation["suite"].as_str().unwrap_or("unknown"),
                            validation["cases"].as_u64().unwrap_or(0)
                        );
                    }
                    return Ok(ExitCode::SUCCESS);
                }
                let report = usefulness::run(
                    &paths,
                    usefulness::BenchmarkOptions {
                        model: cli.model.clone(),
                        case,
                        max_steps,
                        deadline: Duration::from_secs(deadline_secs),
                    },
                )?;
                println!("{}", usefulness::render(&report, json)?);
                Ok(if report.failed == 0 {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(3)
                })
            }
        },
        Some(Commands::Service { action }) => match action {
            ServiceCommand::Offers { query, limit, json } => {
                let offers = service::offers(&paths, &query.join(" "), limit);
                println!("{}", service::render_offers(&offers, json)?);
                Ok(ExitCode::SUCCESS)
            }
            ServiceCommand::Request {
                need,
                capability,
                authority,
                done_when,
                proof,
                json,
            } => {
                let authority =
                    resolve_authority(false, authority.as_deref(), AuthorityContext::Operator)?;
                let request = service::create_request(
                    &paths,
                    &need.join(" "),
                    capability.as_deref(),
                    authority,
                    &done_when,
                    &proof,
                )?;
                println!("{}", service::render_request(&request, json)?);
                Ok(ExitCode::SUCCESS)
            }
            ServiceCommand::Requests { json } => {
                let requests = service::list_requests(&paths)?;
                println!("{}", service::render_requests(&requests, json)?);
                Ok(ExitCode::SUCCESS)
            }
            ServiceCommand::Show { id, json } => {
                let request = service::read_request(&paths, &id)?;
                println!("{}", service::render_request(&request, json)?);
                Ok(ExitCode::SUCCESS)
            }
            ServiceCommand::Fulfill { id, verify, json } => {
                let request = service::read_request(&paths, &id)?;
                let spec = service::prepare_fulfillment(&paths, &request)?;
                let workspace = workspace(cli.cwd.clone())?;
                let receipt = agent::run(
                    &paths,
                    RunOptions {
                        goal: spec.goal,
                        workspace,
                        model: cli.model.clone(),
                        review: false,
                        review_model: None,
                        max_steps: cli.max_steps,
                        dry_run: false,
                        verbose: false,
                        authority: spec.authority,
                        done_when: Some(spec.done_when),
                        verify,
                        outcome_requirements: None,
                        use_context: true,
                        context_sources: vec![format!("hii-service-request:{}", request.id)],
                        system_context: Vec::new(),
                        output: if json {
                            RunOutput::Quiet
                        } else {
                            RunOutput::Human
                        },
                        stream: StreamPolicy::Auto,
                        allow_missing_verify_deps: false,
                        budgets: Budgets {
                            max_steps: cli.max_steps,
                            max_tokens: cli.token_budget,
                            wall_clock: match cli.deadline.as_deref() {
                                Some(value) => parse_duration(value)?,
                                None => Some(Duration::from_secs(DEFAULT_WALL_CLOCK_SECS)),
                            },
                            ..Budgets::default()
                        },
                        last_message: None,
                        hooks: lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile),
                        coding: false,
                        skill_ids: spec.skill_ids,
                        autonomy_level: AutonomyLevel::LocalFull,
                    },
                )?;
                let request = service::record_fulfillment(&paths, &request.id, &receipt)?;
                println!("{}", service::render_request(&request, json)?);
                Ok(ExitCode::from(receipt.exit_code))
            }
        },
        Some(Commands::Project { action }) => {
            let render_project = |project: &project::Project, json: bool| -> Result<(), String> {
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(project).map_err(|error| error.to_string())?
                    );
                } else {
                    println!("{}", project::format_project(project));
                }
                Ok(())
            };
            match action {
                ProjectCommand::Bind { root, name, json } => {
                    let binding = hii_core::adaptive::bind(&paths.runtime, &root, name.as_deref())?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&binding).map_err(|e| e.to_string())?
                        );
                    } else {
                        println!(
                            "{}  {}  {}",
                            binding.id, binding.validation_status, binding.canonical_root
                        );
                    }
                }
                ProjectCommand::Create {
                    name,
                    project_type,
                    location,
                    currency,
                    budget,
                    base_hours,
                    blended_rate,
                    consultant_allowance,
                    direct_costs,
                    contingency_bps,
                    markup_bps,
                    total_weeks,
                    options,
                    json,
                } => {
                    let project = project::create(
                        &paths.runtime,
                        project::CreateOptions {
                            name: name.join(" "),
                            project_type,
                            location,
                            currency,
                            construction_budget: budget,
                            base_hours,
                            blended_rate,
                            consultant_allowance,
                            direct_costs,
                            contingency_bps,
                            markup_bps,
                            total_weeks,
                            option_count: options,
                        },
                    )?;
                    render_project(&project, json)?;
                }
                ProjectCommand::List { delivery, json } => {
                    let projects = project::list(&paths.runtime)?;
                    if delivery {
                        if json {
                            println!(
                                "{}",
                                serde_json::to_string_pretty(&projects)
                                    .map_err(|error| error.to_string())?
                            );
                        } else if projects.is_empty() {
                            println!(
                                "No HII delivery projects yet. Run `hii project create <name>`. "
                            );
                        } else {
                            for project in projects {
                                println!(
                                    "{:<28} {:<10} {:<28} {}",
                                    project.id, project.status, project.current_phase, project.name
                                );
                            }
                        }
                        return Ok(ExitCode::SUCCESS);
                    }
                    let bound = hii_core::adaptive::projects(&paths.runtime)?;
                    if json {
                        let rows = bound.into_iter().map(|value| serde_json::to_value(value).unwrap()).chain(projects.into_iter().map(|value| serde_json::json!({"kind":"deliveryProfileProject","project":value}))).collect::<Vec<_>>();
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?
                        );
                    } else if projects.is_empty() && bound.is_empty() {
                        println!("No HII projects yet. Run `hii project bind <root>`. ");
                    } else {
                        for p in bound {
                            println!("{:<38} {:<18} {}", p.id, p.validation_status, p.name);
                        }
                        for p in projects {
                            println!("{:<38} {:<18} {}", p.id, "delivery-profile", p.name);
                        }
                    }
                }
                ProjectCommand::Validate { id, json } => {
                    let binding = hii_core::adaptive::validate(&paths.runtime, &id)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&binding).map_err(|e| e.to_string())?
                        );
                    } else {
                        println!("{}  {}", binding.id, binding.validation_status);
                    }
                }
                ProjectCommand::Show { id, json } => {
                    render_project(&project::load(&paths.runtime, &id)?, json)?;
                }
                ProjectCommand::Price {
                    id,
                    base_hours,
                    blended_rate,
                    consultant_allowance,
                    direct_costs,
                    contingency_bps,
                    markup_bps,
                    total_weeks,
                    options,
                    json,
                } => {
                    let project = project::reprice(
                        &paths.runtime,
                        &id,
                        project::RepriceOptions {
                            base_hours,
                            blended_rate,
                            consultant_allowance,
                            direct_costs,
                            contingency_bps,
                            markup_bps,
                            total_weeks,
                            option_count: options,
                        },
                    )?;
                    render_project(&project, json)?;
                }
                ProjectCommand::Triage { id, json } => {
                    let project = project::load(&paths.runtime, &id)?;
                    let triage = project::triage(&project);
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&triage)
                                .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!("Project triage — {}\n", project.name);
                        for kpi in &triage.kpis {
                            println!(
                                "{:<12} {:<44} {} / {}",
                                kpi.status, kpi.name, kpi.value, kpi.target
                            );
                        }
                        if !triage.attention.is_empty() {
                            println!("\nAttention");
                            for item in &triage.attention {
                                println!("  {}  {} — {}", item.priority, item.id, item.summary);
                            }
                        }
                        if !triage.next_actions.is_empty() {
                            println!("\nNext actions");
                            for action in &triage.next_actions {
                                println!("  - {action}");
                            }
                        }
                    }
                }
                ProjectCommand::StakeholderAdd {
                    id,
                    name,
                    role,
                    decision_scope,
                    json,
                } => render_project(
                    &project::add_stakeholder(&paths.runtime, &id, &name, &role, &decision_scope)?,
                    json,
                )?,
                ProjectCommand::KpiAdd {
                    id,
                    name,
                    unit,
                    target,
                    calculation,
                    owner,
                    json,
                } => render_project(
                    &project::add_kpi(
                        &paths.runtime,
                        &id,
                        &name,
                        &unit,
                        &target,
                        &calculation,
                        &owner,
                    )?,
                    json,
                )?,
                ProjectCommand::KpiUpdate {
                    id,
                    kpi,
                    value,
                    sources,
                    actor,
                    json,
                } => render_project(
                    &project::update_kpi(&paths.runtime, &id, &kpi, &value, &sources, &actor)?,
                    json,
                )?,
                ProjectCommand::TaskAdd {
                    id,
                    title,
                    phase,
                    system,
                    owner,
                    depends_on,
                    kpis,
                    budget_lines,
                    evidence_required,
                    json,
                } => render_project(
                    &project::add_task(
                        &paths.runtime,
                        &id,
                        project::AddTaskOptions {
                            title: title.join(" "),
                            phase,
                            system,
                            owner,
                            depends_on,
                            kpi_ids: kpis,
                            budget_line_ids: budget_lines,
                            evidence_required,
                        },
                    )?,
                    json,
                )?,
                ProjectCommand::Select {
                    id,
                    option,
                    actor,
                    json,
                } => render_project(
                    &project::select_option(&paths.runtime, &id, &option, &actor)?,
                    json,
                )?,
                ProjectCommand::TaskComplete {
                    id,
                    task,
                    evidence,
                    actor,
                    json,
                } => render_project(
                    &project::complete_task(&paths.runtime, &id, &task, &evidence, &actor)?,
                    json,
                )?,
                ProjectCommand::QuestionAdd {
                    id,
                    question,
                    asked_by,
                    owner,
                    json,
                } => render_project(
                    &project::add_question(
                        &paths.runtime,
                        &id,
                        &question.join(" "),
                        &asked_by,
                        &owner,
                    )?,
                    json,
                )?,
                ProjectCommand::QuestionAnswer {
                    id,
                    question,
                    answer,
                    sources,
                    actor,
                    json,
                } => render_project(
                    &project::answer_question(
                        &paths.runtime,
                        &id,
                        &question,
                        &answer.join(" "),
                        &sources,
                        &actor,
                    )?,
                    json,
                )?,
                ProjectCommand::SupplierAdd {
                    id,
                    need,
                    name,
                    url,
                    contact,
                    json,
                } => render_project(
                    &project::add_supplier(&paths.runtime, &id, &need, &name, url, contact)?,
                    json,
                )?,
                ProjectCommand::SupplierSearch {
                    id,
                    need,
                    limit,
                    json,
                } => {
                    let (project, query, added) =
                        project::research_suppliers(&paths.runtime, &id, &need, limit)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::json!({
                                "kind": "hii.project.supplier-research/1",
                                "query": query,
                                "added": added,
                                "project": project,
                            }))
                            .map_err(|error| error.to_string())?
                        );
                    } else {
                        println!("Supplier research · {added} candidate(s) added\nquery: {query}");
                        if let Some(need) = project.supplier_needs.iter().find(|candidate| {
                            candidate.id == need || candidate.id.starts_with(&need)
                        }) {
                            for supplier in &need.suppliers {
                                println!(
                                    "  {}\n    {}",
                                    supplier.name,
                                    supplier.url.as_deref().unwrap_or("no public URL")
                                );
                            }
                        }
                        println!("\nNo supplier was contacted. Review candidates, then generate an RFQ draft.");
                    }
                }
                ProjectCommand::SupplierQuote {
                    id,
                    need,
                    supplier,
                    amount,
                    source,
                    json,
                } => render_project(
                    &project::record_quote(
                        &paths.runtime,
                        &id,
                        &need,
                        &supplier,
                        &amount,
                        &source,
                    )?,
                    json,
                )?,
                ProjectCommand::Rfq { id, need } => {
                    let project = project::load(&paths.runtime, &id)?;
                    println!("{}", project::rfq(&project, &need)?);
                }
                ProjectCommand::PhaseApprove {
                    id,
                    phase,
                    actor,
                    note,
                    json,
                } => render_project(
                    &project::approve_phase(&paths.runtime, &id, &phase, &actor, &note)?,
                    json,
                )?,
                ProjectCommand::Advance { id, json } => {
                    render_project(&project::advance(&paths.runtime, &id)?, json)?;
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Thread { action }) => {
            match action {
                ThreadCommand::Create {
                    project,
                    objective,
                    json,
                } => {
                    let t = hii_core::adaptive::create_thread(
                        &paths.runtime,
                        &project,
                        &objective.join(" "),
                    )?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&t).map_err(|e| e.to_string())?
                        )
                    } else {
                        println!("{}  {}", t.id, t.objective)
                    }
                }
                ThreadCommand::List { project, json } => {
                    let ts = hii_core::adaptive::threads(&paths.runtime, &project)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&ts).map_err(|e| e.to_string())?
                        )
                    } else {
                        for t in ts {
                            println!("{}  {:<8} {}", t.id, t.status, t.objective)
                        }
                    }
                }
                ThreadCommand::Activate {
                    project,
                    thread,
                    json,
                } => {
                    let f = hii_core::adaptive::activate_thread(&paths.runtime, &project, &thread)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?
                        )
                    } else {
                        println!("foreground  {}", f.foreground_thread_id)
                    }
                }
                ThreadCommand::Show {
                    thread,
                    project,
                    json,
                } => {
                    let t = hii_core::adaptive::thread(&paths.runtime, &thread)?;
                    let p = project.unwrap_or_else(|| t.project_id.clone());
                    let s = hii_core::adaptive::snapshot(&paths.runtime, &p, &t.id)?;
                    if json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?
                        )
                    } else {
                        println!(
                            "{}\n{}\nevents  {}",
                            s.thread.objective,
                            s.thread.status,
                            s.interaction_events.len()
                        )
                    }
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Interact {
            project,
            thread,
            interaction,
            proposal,
            jsonl,
        }) => {
            let proposal: hii_core::adaptive::InteractionProposalV1 =
                serde_json::from_str(&proposal)
                    .map_err(|e| format!("invalid InteractionProposalV1: {e}"))?;
            let interaction_id = interaction.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let (kind, text) = match &proposal {
                hii_core::adaptive::InteractionProposalV1::Respond { text } => {
                    ("interaction.respond", Some(text.clone()))
                }
                hii_core::adaptive::InteractionProposalV1::Capability { .. } => {
                    ("interaction.capability.proposed", None)
                }
                hii_core::adaptive::InteractionProposalV1::Ask { text } => {
                    ("interaction.ask", Some(text.clone()))
                }
                hii_core::adaptive::InteractionProposalV1::Finish { summary } => {
                    ("interaction.finish", Some(summary.clone()))
                }
            };
            let event = hii_core::adaptive::append_event(
                &paths.runtime,
                hii_core::adaptive::InteractionEventV1 {
                    schema_version: 1,
                    id: String::new(),
                    interaction_id: interaction_id.clone(),
                    project_id: project.clone(),
                    thread_id: thread.clone(),
                    run_id: None,
                    sequence: 0,
                    timestamp: String::new(),
                    kind: kind.into(),
                    text,
                    payload: serde_json::to_value(&proposal).map_err(|e| e.to_string())?,
                    causation_event_id: None,
                },
                &format!("interaction:{interaction_id}:proposal"),
            )?;
            let snapshot = hii_core::adaptive::snapshot(&paths.runtime, &project, &thread)?;
            if jsonl {
                println!(
                    "{}",
                    serde_json::to_string(&event).map_err(|e| e.to_string())?
                );
                println!(
                    "{}",
                    serde_json::to_string(&snapshot).map_err(|e| e.to_string())?
                )
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?
                )
            };
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::ToolsManifest) => {
            println!("{}", acp::render());
            Ok(ExitCode::SUCCESS)
        }
        Some(Commands::Tools { action }) => tools_command(&paths, action),
        Some(Commands::Mcp {
            authority,
            client_identity,
        }) => {
            let workspace = workspace(cli.cwd.clone())?;
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
        Some(Commands::Completions { shell }) => {
            use clap::CommandFactory;
            // Generate into an in-memory buffer rather than directly into stdout:
            // clap_complete's writer panics on a write error, and piping the
            // output into `head`/`grep -m1`/etc. closes stdout mid-write.
            let mut script = Vec::new();
            clap_complete::generate(shell, &mut Cli::command(), "hii", &mut script);
            match io::stdout().write_all(&script) {
                Ok(()) => Ok(ExitCode::SUCCESS),
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(ExitCode::SUCCESS),
                Err(error) => Err(format!("failed to print completion script: {error}")),
            }
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
    let workspace = workspace(cli.cwd.clone())?;
    let public_test = cli.session_profile == SessionProfile::PublicTest;
    let hooks_enabled = lifecycle_hooks_enabled(cli.no_hooks, cli.session_profile);
    let create = || {
        Conversation::new(
            paths.clone(),
            workspace.clone(),
            cli.model.clone(),
            cli.max_steps,
            public_test,
            hooks_enabled,
        )
    };
    let mut conversation = match create() {
        Ok(conversation) => conversation,
        Err(error)
            if !public_test
                && error.contains("cannot reach HII")
                && io::stdin().is_terminal()
                && io::stdout().is_terminal() =>
        {
            tui::system(
                "Welcome to HII. HII is not prepared on this machine yet.\nSet up the private hardware-optimized local runtime now? [Y/n]",
            );
            let mut answer = String::new();
            io::stdin()
                .read_line(&mut answer)
                .map_err(|read_error| read_error.to_string())?;
            if matches!(answer.trim().to_ascii_lowercase().as_str(), "n" | "no") {
                return Err("HII setup was skipped. Run `hii runner model start` when ready, or use `hii login codex|claude` for an explicit hosted provider.".into());
            }
            let args = ["runner", "model", "start"]
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            if legacy::run(&paths.repo, &args)? != 0 {
                return Err(
                    "HII setup did not start. Run `hii runner model logs` for details.".into(),
                );
            }
            tui::system("◇ MODEL LOADING  HII · acquiring the local model; live model events begin when the runner is ready.");
            let started = std::time::Instant::now();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                match create() {
                    Ok(conversation) => break conversation,
                    Err(wait_error) if started.elapsed() < std::time::Duration::from_secs(1800) => {
                        if !wait_error.contains("cannot reach HII") {
                            return Err(wait_error);
                        }
                    }
                    Err(wait_error) => return Err(format!(
                        "HII did not become ready within 30 minutes: {wait_error}. Run `hii runner model logs`."
                    )),
                }
            }
        }
        Err(error) => return Err(error),
    };
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
            // Raw-mode keyboard model: Enter=submit, Shift+Tab=queue, Esc/Ctrl+B/Ctrl+T
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
                keyboard::InputEvent::AutoAdvisor => match conversation.auto_advisor_suggestion() {
                    Ok((route, action, reason)) => {
                        tui::system(&format!(
                                "AUTO ADVISOR · {route}\n{action}\nWhy: {reason}\n\nRun this suggestion? [y/N]"
                            ));
                        if keyboard::confirm_suggestion()? {
                            println!("y");
                            action
                        } else {
                            println!("n");
                            tui::system("Suggestion dismissed. Auto Advisor made no changes.");
                            continue;
                        }
                    }
                    Err(error) => {
                        tui::error(&error);
                        continue;
                    }
                },
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
            Some(SlashCommand::Help(all)) => Ok(if conversation.is_public_test() {
                public_test_slash_help().to_string()
            } else if all {
                slash_help()
            } else {
                slash_help_compact()
            }),
            Some(SlashCommand::Compact) => conversation.compact(),
            Some(SlashCommand::Clear) => conversation.clear(),
            Some(SlashCommand::Overview) => Ok(conversation.overview()),
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
            Some(SlashCommand::Settings(requested)) => conversation.settings(requested.as_deref()),
            Some(SlashCommand::Keymap(requested)) => {
                conversation.keymap_command(requested.as_deref())
            }
            Some(SlashCommand::Model(model)) => conversation.model(model.as_deref()),
            Some(SlashCommand::DynamicControl(args)) => legacy::output(&paths.repo, &args),
            Some(SlashCommand::Files) => match file_explorer::browse(conversation.workspace())? {
                Some(path) => conversation.attach(&path.display().to_string()),
                None => Ok("File explorer closed.".into()),
            },
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
            Some(SlashCommand::Copy(target)) => conversation.copy_latest(&target),
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
                    slash_help_compact()
                };
                Ok(format!("Unknown command: {command}\n\n{help}"))
            }
            None => {
                show_activity = true;
                tui::user_turn(goal);
                conversation.begin_flow(goal)?;
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
                tui::finish_activity();
                if !reply.trim().is_empty() {
                    tui::reply(&reply, None);
                }
            }
            Err(error) => {
                tui::finish_activity();
                match conversation::operator_stop(&error) {
                    Some(conversation::OperatorStop::Exited) => break,
                    Some(conversation::OperatorStop::Interrupted) => {}
                    None => tui::error(&error),
                }
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[derive(Debug, PartialEq)]
enum SlashCommand {
    Help(bool),
    Compact,
    Clear,
    Overview,
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
    Settings(Option<String>),
    Keymap(Option<String>),
    Model(Option<String>),
    DynamicControl(Vec<String>),
    Files,
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
    Copy(String),
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
        "/help" if argument.is_none() => SlashCommand::Help(false),
        "/help" if rest == "all" => SlashCommand::Help(true),
        "/compact" if argument.is_none() => SlashCommand::Compact,
        "/clear" if argument.is_none() => SlashCommand::Clear,
        "/overview" if argument.is_none() => SlashCommand::Overview,
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
        "/settings" => SlashCommand::Settings(argument),
        "/keymap" => SlashCommand::Keymap(argument),
        "/raw" => match rest {
            "" | "on" => SlashCommand::Thinking(Some("raw".into())),
            "off" => SlashCommand::Thinking(Some("stream".into())),
            _ => SlashCommand::Unknown(input.into()),
        },
        "/model" => SlashCommand::Model(argument),
        "/models" if rest.is_empty() => SlashCommand::Model(None),
        "/files" | "/explore" if rest.is_empty() => SlashCommand::Files,
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
        "/copy" => SlashCommand::Copy(rest.to_ascii_lowercase()),
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
        _ => slash_registry::resolve(command, rest)
            .map(SlashCommand::DynamicControl)
            .unwrap_or_else(|| SlashCommand::Unknown(input.to_string())),
    })
}

fn slash_help() -> String {
    let help = if cfg!(feature = "preview") {
        "/help                         show commands\n/providers                    show local, Codex, and Claude access\n/login codex|claude           connect an existing provider plan\n/compact                      summarize and shrink this conversation\n/clear | /new                 start with fresh context\n/rename <name>                name this saved session\n/copy [code|all]              copy the latest response, its last code block, or the transcript\n/status                       show session, workspace, model, and usage\n/goal [edit|pause|resume|clear] [objective]\n                               track a persistent session objective\n/plan [off|prompt]            inspect and research without changes\n/side <question>              ask without changing the main conversation\n/theme [name]                 switch the persistent visual signature\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw model stream\n/raw [on|off]                 toggle the raw model stream\n/model [name]                 list or switch available models\n/files                        browse files with ranger/vim keys\n/proof [run-id]               inspect execution proof\n/diff                         inspect scoped workspace changes\n/review                       review current diff for defects\n/permissions [level]          show or switch the live authority boundary\n/resume [session-id]          list or restore a prior session\n/skills                       show automatically learned skill drafts\n/agents | /ps                 show HII-managed and observed agents\n/codex <task>                 use authenticated Codex CLI\n/claude <task>                use authenticated Claude CLI\n/agent <id> status|logs|stop  manage an agent by id\n/stop <id>                    stop one managed agent\n/resources                    quick CPU, memory, storage, and Ollama view\n/top                          open the embedded btop resource monitor\n/schedule <cron> :: <task>    create a local recurring HII task\n/schedules                    list HII schedules\n/calendar                     show the next 7 days\n/calendar add DATE [TIME] :: TITLE\n/sync calendar                sync next HII runs to Apple Calendar\n/exit                         leave HII\n\nWhile running: type + Enter steers · type + Tab queues · Esc stops"
    } else {
        "/help                         show commands\n/providers                    show local, Codex, and Claude access\n/login codex|claude           connect an existing provider plan\n/compact                      summarize and shrink this conversation\n/clear | /new                 start with fresh context\n/rename <name>                name this saved session\n/copy [code|all]              copy the latest response, its last code block, or the transcript\n/status                       show session, workspace, model, and usage\n/goal [edit|pause|resume|clear] [objective]\n                               track a persistent session objective\n/plan [off|prompt]            inspect and research without changes\n/side <question>              ask without changing the main conversation\n/theme [name]                 switch the persistent visual signature\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw model stream\n/raw [on|off]                 toggle the raw model stream\n/model [name]                 list or switch available models\n/files                        browse files with ranger/vim keys\n/proof [run-id]               inspect execution proof\n/diff                         inspect scoped workspace changes\n/review                       review current diff for defects\n/permissions [level]          show or switch the live authority boundary\n/resume [session-id]          list or restore a prior session\n/skills                       show automatically learned skill drafts\n/agents | /ps                 show HII-managed and observed agents\n/codex <task>                 use authenticated Codex CLI\n/claude <task>                use authenticated Claude CLI\n/agent <id> status|logs|stop  manage an agent by id\n/stop <id>                    stop one managed agent\n/schedule <cron> :: <task>    create local recurring HII work\n/schedules                    list recurring HII work\n/calendar                     show the next 7 days\n/calendar add DATE [TIME] :: TITLE\n/sync calendar                sync HII schedules to Apple Calendar\n/undo                         drop the last exchange to steer away\n/fork                         snapshot this session to a resumable fork\n/teach <name>                 graduate this session into a reusable skill\n!<command>                    run a shell command directly\n/exit                         leave HII\n\nWhile running: type + Enter steers · type + Tab queues · Esc stops"
    };
    help.replace("type + Tab queues", "type + Shift+Tab queues")
    .replace(
        "/skills                       show automatically learned skill drafts\n",
        "/skills                       show automatically learned skill drafts\n/hooks                        inspect approved lifecycle policy\n/mcp                          show governed MCP clients\n/mcp add|refresh|show|trust   configure and discover MCP tools\n/background <task>            start one supervised local HII job\n/jobs                         list background jobs\n/job <id> status|logs|proof|cancel\n                               inspect or stop one background job\n",
    )
    .replace(
        "/status                       show session, workspace, model, and usage\n",
        "/overview                     render the contextual state map\n/status                       show session, workspace, model, and usage\n/attach <path>                add workspace text/image context\n/attachments                  show pending context and size\n/detach [number|all]          remove pending context\n",
    )
    .replace(
        "/theme [name]                 switch the persistent visual signature\n",
        "/theme [name]                 switch the persistent visual signature\n/settings [key value]         configure conversation and inline images\n/keymap [default|vim]          inspect or switch keyboard profile\n/keymap bind ACTION CHORD      add a safe custom binding\n",
    )
    .replace(
        "/thinking [mode]              off | compact | raw model stream\n/raw [on|off]                 toggle the raw model stream\n",
        "/thinking [mode]              conversation | stream | flow | activity\n/raw [on|off]                 toggle the direct model and tool stream\n/reasoning [mode]             auto | off | deep model effort\n/mode [coding|general|auto|local|private|best]\n                               choose coding behavior or provider routing\n/autonomy [local-full|approval]\n                               choose local autonomy policy\n/model save                   persist the current user-determined model\n/learn [status]               show learning memory\nConversation is the default; Stream and diagnostics are developer views.\nAuto-compact is on by default.\n",
    )
}

fn slash_help_compact() -> String {
    "CREATE + ACT\n  Describe the outcome you want. HII can inspect, make, and verify.\n  !<command>             run a shell command directly\n  /attach <path>         add a file or image\n  /plan [prompt|off]     explore without changing anything\n\nYOUR WORK\n  /status                session, workspace, model, and usage\n  /overview              projects, context, and latest proof\n  /proof [run-id]        inspect what completed\n  /diff                   see workspace changes\n  /files                  browse and attach local files\n\nSHAPE THE SESSION\n  /model                  choose a model\n  /theme                  choose the visual signature\n  /permissions            inspect or change authority\n  /undo                   remove the last exchange\n  /new                    begin with fresh context\n  /exit                   leave HII\n\nType / to browse controls  ·  /help all for the complete reference\nWhile HII works: Enter steers  ·  Tab queues  ·  Esc stops"
        .replace("Tab queues", "Shift+Tab queues")
}

fn public_test_slash_help() -> String {
    "/help                         show commands\n/compact                      summarize and shrink this conversation\n/clear | /new                 start with fresh context\n/status                       show isolated session, workspace, model, and usage\n/attach <path>                add workspace text/image context\n/attachments                  show pending context and size\n/detach [number|all]          remove pending context\n/theme [name]                 switch the terminal theme\n/keymap [default|vim]          inspect or switch keyboard profile\n/usage                        show tokens, speed, time, and context\n/thinking [mode]              off | compact | raw display\n/reasoning [mode]             auto | off | deep model effort\n/raw [on|off]                 toggle the raw model stream\n/model [name]                 list or switch available models\n/proof [run-id]               inspect isolated execution proof\n/permissions                  show the tester-safe authority boundary\n/undo                         drop the last exchange\n/exit                         leave HII\n\nAttachments must already exist inside this disposable workspace. Installed Mac tools are available to HII inside it. Direct shell input and deletion are unavailable."
        .replace(
            "/thinking [mode]              off | compact | raw display\n/reasoning [mode]             auto | off | deep model effort\n/raw [on|off]                 toggle the raw model stream\n",
            "/thinking [mode]              conversation | flow | activity | diagnostics\n/reasoning [mode]             auto | off | deep model effort\n/raw [on|off]                 toggle diagnostics\n",
        )
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
    let workspace = workspace(cwd)?;
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
    let workspace = workspace(cwd)?;
    let ollama = Ollama::discover();
    let native_status = native_model_status(paths);
    let checks = [
        (
            "Rust binary",
            true,
            "",
            env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
        ),
        (
            "Workspace",
            workspace.is_dir(),
            "pass an existing directory with --cwd, or cd into your project first",
            workspace.display().to_string(),
        ),
        (
            "HII runtime",
            paths.runtime.is_dir(),
            "run any `hii` command once to create it, or set HII_HOME to a writable path",
            paths.runtime.display().to_string(),
        ),
        (
            "Git",
            command_text("git", &["--version"], &workspace).is_some(),
            "install Git: `xcode-select --install` on macOS",
            "git --version".into(),
        ),
        (
            // Search backend is never fatal: absent rg falls back to a native walk.
            "Search",
            true,
            "",
            if command_text("rg", &["--version"], &workspace).is_some() {
                "ripgrep".into()
            } else {
                "native (rg not found)".into()
            },
        ),
        (
            "Shell",
            true,
            "",
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
            "",
            format!("{} ({:?})", ollama.base_url(), ollama.provider()),
        ),
    ];
    let mut ok = true;
    // A diagnostic that only names what is broken leaves the user exactly where
    // they started. Every failable check carries the command that fixes it.
    let mut fixes: Vec<String> = Vec::new();
    for (name, passed, fix, detail) in checks {
        ok &= passed;
        println!("{}  {name:<14} {detail}", if passed { "ok" } else { "!!" });
        if !passed && !fix.is_empty() {
            fixes.push(format!("{name}: {fix}"));
        }
    }
    match ollama.models() {
        Ok(models) => {
            let default_model = ollama.provider().default_model();
            let review_model = ollama.provider().default_review_model();
            let selected_model = native_status
                .as_ref()
                .and_then(|status| status["selection"]["model"].as_str())
                .unwrap_or(default_model);
            let loaded_model = native_status
                .as_ref()
                .and_then(|status| status["loadedModel"].as_str())
                .or_else(|| {
                    (models.len() == 1)
                        .then(|| models.first().map(String::as_str))
                        .flatten()
                });
            let selected = models.iter().any(|model| model == selected_model);
            let loaded_matches_selection = loaded_model.is_none_or(|model| model == selected_model);
            let review = models.iter().any(|model| model == review_model);
            ok &= selected && loaded_matches_selection;
            println!(
                "{}  {:<14} {}",
                if selected { "ok" } else { "!!" },
                format!("{} agent", ollama.provider_label()),
                selected_model
            );
            if !selected {
                fixes.push(format!(
                    "{} agent: the selected or loaded model is not advertised by {}; start it with `hii model use {selected_model}` or choose another with `hii model use <model>`",
                    ollama.provider_label(),
                    ollama.provider_label()
                ));
            }
            if selected_model != default_model {
                println!("--  {:<14} {}", "configured", default_model);
            }
            if let Some(loaded_model) = loaded_model {
                let loaded_ok = loaded_model == selected_model;
                println!(
                    "{}  {:<14} {}",
                    if loaded_ok { "ok" } else { "!!" },
                    "loaded",
                    loaded_model
                );
                if !loaded_ok {
                    fixes.push(format!(
                        "{} loaded: runtime is serving {loaded_model}, but HII selected {selected_model}; run `hii model use {selected_model}` or update the selection",
                        ollama.provider_label()
                    ));
                }
            }
            // Only worth saying when it is a different pull than the agent model's.
            if !review && review_model != default_model {
                fixes.push(format!(
                    "{} review: optional; `ollama pull {review_model}` enables `hii run --review`",
                    ollama.provider_label()
                ));
            }
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
            fixes.push(format!(
                "{}: no model backend answered at {}; start it, or set HII_MODEL_URL to one \
                 that is running",
                ollama.provider_label(),
                ollama.base_url()
            ));
        }
    }
    if !fixes.is_empty() {
        println!("\nTo fix:");
        for fix in &fixes {
            println!("  {fix}");
        }
    }
    println!("\n{}", if ok { "ready" } else { "not ready" });
    Ok(ok)
}

fn interactive_doctor_script(paths: &AppPaths) -> PathBuf {
    paths.repo.join("scripts/hii-cli-interactive-smoke.mjs")
}

fn run_interactive_doctor(paths: &AppPaths, real: bool) -> Result<ExitCode, String> {
    let script = interactive_doctor_script(paths);
    if !script.is_file() {
        return Err(format!(
            "missing interactive smoke test at {}; HII repo resolved to {}",
            script.display(),
            paths.repo.display()
        ));
    }
    if command_text("node", &["--version"], &paths.repo).is_none() {
        return Err("node is required for `hii doctor interactive`".into());
    }

    let status = Command::new("node")
        .arg(&script)
        .args(real.then_some("--real"))
        .current_dir(&paths.repo)
        .status()
        .map_err(|error| format!("failed to run {}: {error}", script.display()))?;
    Ok(status
        .code()
        .and_then(|code| u8::try_from(code).ok())
        .map(ExitCode::from)
        .unwrap_or_else(|| ExitCode::from(1)))
}

fn native_model_status(paths: &AppPaths) -> Option<serde_json::Value> {
    let script = paths.repo.join("aii/daemon/hiid.mjs");
    if !script.is_file() {
        return None;
    }
    let output = Command::new("node")
        .arg(script)
        .args(["model-runtime", "status"])
        .current_dir(&paths.repo)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn information_command(
    paths: &AppPaths,
    workspace: &std::path::Path,
    action: InfoCommand,
) -> Result<(), String> {
    use hii_core::information;
    match action {
        InfoCommand::Capture { url, json } => {
            let result = information::capture(&paths.runtime, workspace, &url)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
                );
            } else {
                println!("captured   {}", result.source.title);
                println!("source     {}", result.source.id);
                println!("url        {}", result.source.url);
                println!("images     {}", result.images.len());
                println!("changed    {}", if result.changed { "yes" } else { "no" });
                println!("hash       {}", result.source.content_hash);
                println!("proof      hii proof {}", result.receipt_id);
            }
        }
        InfoCommand::Find {
            query,
            web,
            limit,
            json,
        } => {
            let query = query.join(" ");
            let results = if web {
                information::discover_web(&query, limit)?
            } else {
                information::search(&paths.runtime, &query, limit)?
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "query": query,
                        "scope": if web { "web" } else { "captured" },
                        "results": results
                    }))
                    .map_err(|error| error.to_string())?
                );
            } else if results.is_empty() {
                println!("no information matched {query:?}");
            } else {
                for result in results {
                    println!("{}\n  {}\n  {}", result.title, result.url, result.excerpt);
                }
            }
        }
        InfoCommand::Inspect { id, json } => {
            let (source, images) = information::inspect(&paths.runtime, &id)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({ "source": source, "images": images })
                    )
                    .map_err(|error| error.to_string())?
                );
            } else {
                println!("{}\n{}\n", source.title, source.url);
                println!("{}", source.excerpt);
                println!("\nimages  {}", images.len());
                println!("hash    {}", source.content_hash);
            }
        }
        InfoCommand::Changes { id, json } => {
            let versions = information::versions(&paths.runtime, &id)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&versions).map_err(|error| error.to_string())?
                );
            } else if versions.is_empty() {
                println!("no captured versions for {id}");
            } else {
                for version in versions {
                    println!("{}  {}", version.captured_at, version.content_hash);
                }
            }
        }
        InfoCommand::Export { id, output, json } => {
            let output = if output.is_absolute() {
                output
            } else {
                workspace.join(output)
            };
            let result = information::export_markdown(&paths.runtime, workspace, &id, &output)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
                );
            } else {
                println!("exported   {}", result.output_path);
                println!("hash       {}", result.content_hash);
                println!("proof      hii proof {}", result.receipt_id);
            }
        }
    }
    Ok(())
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
    if let Some(completion) = receipt.completion.as_ref() {
        println!(
            "proof      {} ({})",
            completion.proof_strength.label(),
            if completion.satisfied {
                "satisfied"
            } else {
                "not satisfied"
            }
        );
        for evidence in &completion.evidence {
            let state = if evidence.exists && evidence.is_file {
                "ok"
            } else if evidence.exists {
                "invalid"
            } else {
                "missing"
            };
            println!(
                "  {state}  {} ({} bytes{})",
                evidence.path,
                evidence.bytes,
                evidence
                    .sha256
                    .as_deref()
                    .map(|hash| format!(", sha256 {hash}"))
                    .unwrap_or_default()
            );
        }
        for requirement in &completion.unmet_requirements {
            println!("  !!  {requirement}");
        }
        for warning in &completion.warnings {
            println!("  --  {warning}");
        }
    } else {
        println!("proof      legacy");
    }
    println!("artifacts  {} file(s)", receipt.artifacts.len());
    for artifact in &receipt.artifacts {
        println!("  ->  {artifact}");
    }
    if let Some(review) = receipt.review.as_deref() {
        println!("review     {}", review.replace('\n', "\n           "));
    }
    println!("risk       {}", receipt.risk);
    println!("receipt    {}", path.display());
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemRecord {
    id: String,
    host: String,
    os: String,
    transport: String,
    capabilities: Vec<String>,
    local: bool,
    status: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemsRegistry {
    systems: Vec<SystemRecord>,
}

fn systems_path(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("systems.json")
}

fn load_systems(paths: &AppPaths) -> Result<SystemsRegistry, String> {
    let path = systems_path(paths);
    if !path.exists() {
        return Ok(SystemsRegistry::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn save_systems(paths: &AppPaths, registry: &SystemsRegistry) -> Result<(), String> {
    fs::create_dir_all(&paths.runtime).map_err(|error| error.to_string())?;
    let path = systems_path(paths);
    let raw = serde_json::to_string_pretty(registry).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn network_command(paths: &AppPaths, action: NetworkCommand) -> Result<ExitCode, String> {
    match action {
        NetworkCommand::Certificate {
            action: NetworkCertificateCommand::Create { hosts, port, json },
        } => {
            let config = network::create_certificate(paths, &hosts, port)?;
            let profile = network::network_root(paths).join("hii-network.mobileconfig");
            let report = serde_json::json!({
                "configured": true,
                "nodeId": config.node_id,
                "lanUrls": config.lan_urls,
                "profile": profile,
                "expiresAtUnix": config.certificate_not_after_unix,
                "next": "Install and trust the profile on the owner-controlled iPhone, then run `hii network start`."
            });
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("HII Network certificate ready");
                for url in report["lanUrls"].as_array().into_iter().flatten() {
                    if let Some(url) = url.as_str() {
                        println!("  {url}");
                    }
                }
                println!("profile  {}", profile.display());
                println!("next     install and trust the profile, then `hii network start`");
            }
            Ok(ExitCode::SUCCESS)
        }
        NetworkCommand::Pair { ttl, json } => {
            let report = network::create_pairing(paths, ttl)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("HII browser pairing");
                println!(
                    "{}",
                    report["url"].as_str().unwrap_or("pairing URL unavailable")
                );
                println!("expires  {}", report["expiresAtUnix"]);
            }
            Ok(ExitCode::SUCCESS)
        }
        NetworkCommand::Start { json } => {
            let pid = network::start(paths)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({ "started": true, "pid": pid })
                    )
                    .map_err(|error| error.to_string())?
                );
            } else {
                println!("started HII Network pid={pid}");
            }
            Ok(ExitCode::SUCCESS)
        }
        NetworkCommand::Serve => {
            network::serve(paths)?;
            Ok(ExitCode::SUCCESS)
        }
        NetworkCommand::Stop { json } => {
            let stopped = network::stop(paths)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({ "stopped": stopped }))
                        .map_err(|error| error.to_string())?
                );
            } else if stopped {
                println!("stopped HII Network");
            } else {
                println!("HII Network is not running");
            }
            Ok(ExitCode::SUCCESS)
        }
        NetworkCommand::Status { json } => {
            let report = network::status(paths);
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("HII Network");
                println!("configured  {}", report["configured"]);
                println!("running     {}", report["running"]);
                println!(
                    "truth       {}",
                    report["transportTruth"].as_str().unwrap_or("unknown")
                );
                println!(
                    "lan         {}",
                    report["routes"]["lan"].as_array().map_or(0, Vec::len)
                );
                println!(
                    "internet    {}",
                    report["routes"]["directInternet"]
                        .as_array()
                        .map_or(0, Vec::len)
                );
                println!(
                    "tailscale   {}",
                    report["routes"]["tailscale"].as_array().map_or(0, Vec::len)
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        NetworkCommand::Doctor { json } => {
            let report = network::doctor(paths);
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("HII Network doctor");
                println!("configured   {}", report["configured"]);
                println!(
                    "canvas       {}",
                    if report["upstreamReady"] == true {
                        "ready"
                    } else {
                        "offline"
                    }
                );
                println!(
                    "LAN route    {}",
                    if report["lanCandidatePresent"] == true {
                        "configured"
                    } else {
                        "missing"
                    }
                );
                println!(
                    "internet     {}",
                    if report["directInternetConfigured"] == true {
                        "configured, unproven"
                    } else {
                        "not configured"
                    }
                );
                println!(
                    "Tailscale    {}",
                    if report["tailscaleConfigured"] == true {
                        "configured, optional"
                    } else {
                        "not configured"
                    }
                );
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn systems_command(paths: &AppPaths, action: Option<SystemsCommand>) -> Result<ExitCode, String> {
    match action.unwrap_or(SystemsCommand::List { json: false }) {
        SystemsCommand::Enroll {
            id,
            host,
            os,
            transport,
            capabilities,
            local,
            json,
        } => {
            let mut registry = load_systems(paths)?;
            let host = host.unwrap_or_else(|| {
                if local {
                    "localhost".into()
                } else {
                    id.clone()
                }
            });
            let os = os.unwrap_or_else(|| {
                if local {
                    env::consts::OS.into()
                } else {
                    "unknown".into()
                }
            });
            let capabilities = if capabilities.is_empty() {
                default_system_capabilities(&os, local)
            } else {
                capabilities
            };
            let status = if local { "ready" } else { "pending-agent" }.to_string();
            let record = SystemRecord {
                id: id.clone(),
                host,
                os,
                transport,
                capabilities,
                local,
                status,
            };
            registry.systems.retain(|existing| existing.id != id);
            registry.systems.push(record.clone());
            registry.systems.sort_by(|a, b| a.id.cmp(&b.id));
            save_systems(paths, &registry)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&record).map_err(|error| error.to_string())?
                );
            } else {
                println!(
                    "enrolled {} ({}, {}) · {}",
                    record.id, record.os, record.transport, record.status
                );
                println!("registry  {}", systems_path(paths).display());
            }
            Ok(ExitCode::SUCCESS)
        }
        SystemsCommand::List { json } => {
            let registry = load_systems(paths)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&registry).map_err(|error| error.to_string())?
                );
            } else if registry.systems.is_empty() {
                println!("No enrolled systems yet.");
                println!("start      hii systems enroll <id> --host <host> --os windows|macos");
            } else {
                for system in registry.systems {
                    println!(
                        "{:<18} {:<10} {:<14} {}",
                        system.id, system.os, system.status, system.host
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        SystemsCommand::Status { system, json } => {
            let registry = load_systems(paths)?;
            let systems: Vec<SystemRecord> = match system {
                Some(id) => vec![find_system(&registry, &id)?],
                None => registry.systems,
            };
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({ "systems": systems }))
                        .map_err(|error| error.to_string())?
                );
            } else if systems.is_empty() {
                println!("No enrolled systems yet.");
            } else {
                for system in systems {
                    let caps = system.capabilities.join(",");
                    println!(
                        "{}\n  host       {}\n  os         {}\n  transport  {}\n  status     {}\n  caps       {}",
                        system.id, system.host, system.os, system.transport, system.status, caps
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn on_command(paths: &AppPaths, system: &str, action: OnCommand) -> Result<ExitCode, String> {
    let registry = load_systems(paths)?;
    let record = find_system(&registry, system)?;
    match action {
        OnCommand::Cli {
            args,
            allow_write,
            timeout,
            json,
        } => {
            if record.local || !matches!(record.transport.as_str(), "ssh" | "tailscale-ssh") {
                return Err("remote CLI requires an enrolled SSH peer".into());
            }
            let result = remote_cli::run(
                &paths.runtime,
                &record.host,
                &record.os,
                &args,
                allow_write,
                timeout,
            )?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
                );
            } else {
                print!("{}", result["stdout"].as_str().unwrap_or_default());
                eprint!("{}", result["stderr"].as_str().unwrap_or_default());
                eprintln!(
                    "remote {} · {} · receipt {}",
                    record.id,
                    result["status"].as_str().unwrap_or("unknown"),
                    result["receipt"].as_str().unwrap_or_default()
                );
            }
            return Ok(if result["status"] == "completed" {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            });
        }
        OnCommand::Run { command, cwd, json } => {
            render_system_dispatch(&record, "run", Some(command.join(" ")), cwd, json)?;
        }
        OnCommand::Files { action } => match action {
            OnFilesCommand::Ls { path, json } => {
                render_system_dispatch(&record, "files.ls", Some(path), None, json)?;
            }
        },
        OnCommand::Apps { action } => match action {
            OnAppsCommand::List { json } => {
                render_system_dispatch(&record, "apps.list", None, None, json)?;
            }
        },
        OnCommand::Proof { id, json } => {
            render_system_dispatch(&record, "proof", id, None, json)?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn find_system(registry: &SystemsRegistry, id: &str) -> Result<SystemRecord, String> {
    registry
        .systems
        .iter()
        .find(|system| system.id == id)
        .cloned()
        .ok_or_else(|| format!("unknown system `{id}`; run `hii systems list`"))
}

fn render_system_dispatch(
    system: &SystemRecord,
    action: &str,
    payload: Option<String>,
    cwd: Option<String>,
    json: bool,
) -> Result<(), String> {
    let ready = system.status == "ready";
    let status = if ready { "ready" } else { "pending-agent" };
    let value = serde_json::json!({
        "system": system.id,
        "host": system.host,
        "os": system.os,
        "transport": system.transport,
        "action": action,
        "payload": payload,
        "cwd": cwd,
        "status": status,
        "next": if ready {
            "local executor transport is not wired in this binding yet"
        } else {
            "install and start hii-agent on this system, then rerun the command"
        },
        "receipt": {
            "required": true,
            "scope": "system"
        }
    });
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
        );
    } else {
        println!("system    {} ({})", system.id, system.os);
        println!("action    {action}");
        if let Some(payload) = value["payload"].as_str() {
            println!("payload   {payload}");
        }
        if let Some(cwd) = value["cwd"].as_str() {
            println!("cwd       {cwd}");
        }
        println!("status    {status}");
        println!("next      {}", value["next"].as_str().unwrap_or(""));
        println!("receipt   required");
    }
    Ok(())
}

fn default_system_capabilities(os: &str, local: bool) -> Vec<String> {
    let mut caps = vec![
        "shell".to_string(),
        "files".to_string(),
        "proof".to_string(),
    ];
    let normalized = os.to_ascii_lowercase();
    if normalized.contains("mac") || (local && env::consts::OS == "macos") {
        caps.extend(["apps", "windows", "applescript"].map(str::to_string));
    } else if normalized.contains("win") {
        caps.extend(["apps", "windows", "powershell"].map(str::to_string));
    } else {
        caps.push("apps".into());
    }
    caps.sort();
    caps.dedup();
    caps
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolDraft {
    id: String,
    intent: String,
    authority: String,
    read_only: bool,
    status: String,
    proof: Vec<String>,
    created_at_unix_ms: u128,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolActivity {
    event: String,
    tool: String,
    why: String,
    authority: String,
    effect: Vec<String>,
    proof: Vec<String>,
    next: String,
    created_at_unix_ms: u128,
}

fn tools_command(paths: &AppPaths, action: ToolsCommand) -> Result<ExitCode, String> {
    match action {
        ToolsCommand::Activity { json } => {
            let events = store::read_jsonl::<ToolActivity>(&tool_activity_path(paths))?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&events).map_err(|error| error.to_string())?
                );
            } else if events.is_empty() {
                println!("No autonomous tool activity yet.");
            } else {
                for event in events.iter().rev().take(12).rev() {
                    println!(
                        "{}  {} · {}\n  why       {}\n  authority {}\n  proof     {}\n  next      {}",
                        event.created_at_unix_ms,
                        event.event,
                        event.tool,
                        event.why,
                        event.authority,
                        if event.proof.is_empty() {
                            "pending".into()
                        } else {
                            event.proof.join(", ")
                        },
                        event.next
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        ToolsCommand::Registry { json } => {
            if json {
                println!("{}", acp::render());
            } else {
                for spec in acp::tools() {
                    let annotations = acp::annotations(spec);
                    println!(
                        "{:<18} {:<4} {:<7} {}",
                        spec.name,
                        if spec.mutates { "mut" } else { "read" },
                        spec.reach.label(),
                        spec.description
                    );
                    println!(
                        "  hints readOnly={} destructive={} openWorld={}",
                        annotations["readOnlyHint"].as_bool().unwrap_or(false),
                        annotations["destructiveHint"].as_bool().unwrap_or(false),
                        annotations["openWorldHint"].as_bool().unwrap_or(false)
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        ToolsCommand::Drafts { json } => {
            let drafts = read_tool_drafts(paths)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&drafts).map_err(|error| error.to_string())?
                );
            } else if drafts.is_empty() {
                println!("No draft tools yet.");
            } else {
                for draft in drafts {
                    println!(
                        "{}  {} · {} · proof:{}\n  {}",
                        draft.id,
                        draft.status,
                        draft.authority,
                        if draft.proof.is_empty() {
                            "pending".into()
                        } else {
                            draft.proof.join(", ")
                        },
                        draft.intent
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        ToolsCommand::Propose {
            intent,
            read_only,
            authority,
            json,
        } => {
            let intent = intent.join(" ");
            let id = format!("tool-{}", clock::unix_ms());
            let authority = authority.unwrap_or_else(|| {
                if read_only {
                    "read-only".into()
                } else {
                    "workspace".into()
                }
            });
            let draft = ToolDraft {
                id: id.clone(),
                intent: intent.clone(),
                authority: authority.clone(),
                read_only,
                status: "draft".into(),
                proof: Vec::new(),
                created_at_unix_ms: clock::unix_ms(),
            };
            write_tool_draft(paths, &draft)?;
            append_tool_activity(
                paths,
                ToolActivity {
                    event: "tool.proposed".into(),
                    tool: id.clone(),
                    why: intent,
                    authority,
                    effect: vec![tool_draft_path(paths, &id).display().to_string()],
                    proof: Vec::new(),
                    next: "scaffold and test the draft before promotion".into(),
                    created_at_unix_ms: clock::unix_ms(),
                },
            )?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&draft).map_err(|error| error.to_string())?
                );
            } else {
                println!("proposed  {}", draft.id);
                println!("status    {}", draft.status);
                println!("authority {}", draft.authority);
                println!("next      hii tools scaffold {}", draft.id);
            }
            Ok(ExitCode::SUCCESS)
        }
        ToolsCommand::Scaffold { id } => update_tool_draft(paths, &id, "scaffolded", None),
        ToolsCommand::Test { id } => update_tool_draft(
            paths,
            &id,
            "tested",
            Some("manual scaffold/test marker; replace with deterministic command proof".into()),
        ),
        ToolsCommand::Promote { id, approved } => {
            let draft = read_tool_draft(paths, &id)?;
            if !draft.read_only && !approved {
                return Err(format!(
                    "{id} expands authority; rerun with --approved after human review"
                ));
            }
            update_tool_draft(
                paths,
                &id,
                "promoted",
                Some("human-visible promotion".into()),
            )
        }
        ToolsCommand::Observe { json } => {
            let observations =
                store::read_jsonl::<serde_json::Value>(&tool_observations_path(paths))?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&observations)
                        .map_err(|error| error.to_string())?
                );
            } else if observations.is_empty() {
                println!("No recorded tool observations yet.");
            } else {
                for observation in observations.iter().rev().take(12).rev() {
                    println!("{}", observation);
                }
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn update_tool_draft(
    paths: &AppPaths,
    id: &str,
    status: &str,
    proof: Option<String>,
) -> Result<ExitCode, String> {
    let mut draft = read_tool_draft(paths, id)?;
    draft.status = status.into();
    if let Some(proof) = proof {
        if !draft.proof.contains(&proof) {
            draft.proof.push(proof);
        }
    }
    write_tool_draft(paths, &draft)?;
    append_tool_activity(
        paths,
        ToolActivity {
            event: format!("tool.{status}"),
            tool: draft.id.clone(),
            why: draft.intent.clone(),
            authority: draft.authority.clone(),
            effect: vec![tool_draft_path(paths, &draft.id).display().to_string()],
            proof: draft.proof.clone(),
            next: match status {
                "scaffolded" => format!("hii tools test {}", draft.id),
                "tested" => format!("hii tools promote {}", draft.id),
                "promoted" => {
                    "registry projection can include this after code adapter lands".into()
                }
                _ => "inspect activity and continue".into(),
            },
            created_at_unix_ms: clock::unix_ms(),
        },
    )?;
    println!("{}  {}", status, draft.id);
    Ok(ExitCode::SUCCESS)
}

fn tool_activity_path(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("tool-activity.jsonl")
}

fn tool_observations_path(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("tool-observations.jsonl")
}

fn tool_drafts_dir(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("tool-drafts")
}

fn tool_draft_path(paths: &AppPaths, id: &str) -> PathBuf {
    tool_drafts_dir(paths).join(format!("{id}.json"))
}

fn read_tool_draft(paths: &AppPaths, id: &str) -> Result<ToolDraft, String> {
    let path = tool_draft_path(paths, id);
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn read_tool_drafts(paths: &AppPaths) -> Result<Vec<ToolDraft>, String> {
    let dir = tool_drafts_dir(paths);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut drafts = Vec::new();
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
            let raw = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
            drafts.push(serde_json::from_str(&raw).map_err(|error| error.to_string())?);
        }
    }
    drafts.sort_by(|a: &ToolDraft, b| a.id.cmp(&b.id));
    Ok(drafts)
}

fn write_tool_draft(paths: &AppPaths, draft: &ToolDraft) -> Result<(), String> {
    fs::create_dir_all(tool_drafts_dir(paths)).map_err(|error| error.to_string())?;
    let raw = serde_json::to_string_pretty(draft).map_err(|error| error.to_string())?;
    fs::write(tool_draft_path(paths, &draft.id), format!("{raw}\n"))
        .map_err(|error| error.to_string())
}

fn append_tool_activity(paths: &AppPaths, event: ToolActivity) -> Result<(), String> {
    store::append_jsonl(&tool_activity_path(paths), &event)
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

fn first_command_index(args: &[String]) -> Option<usize> {
    let value_flags = value_taking_globals();
    let mut skip_value = false;
    for (index, arg) in args.iter().enumerate() {
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
        return Some(index);
    }
    None
}

fn first_command(args: &[String]) -> Option<&str> {
    first_command_index(args).map(|index| args[index].as_str())
}

fn public_test_slash_allowed(command: &SlashCommand) -> bool {
    matches!(
        command,
        SlashCommand::Help(_)
            | SlashCommand::Compact
            | SlashCommand::Clear
            | SlashCommand::Overview
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

/// `hii help --all`, `hii --help --all`, or `hii help -a`.
fn wants_full_command_list(args: &[String]) -> bool {
    let mut saw_help = false;
    let mut saw_all = false;
    for arg in args {
        match arg.as_str() {
            "help" | "--help" | "-h" => saw_help = true,
            "--all" | "-a" => saw_all = true,
            _ => return false,
        }
    }
    saw_help && saw_all
}

/// The workspace a command is bound to: `--cwd` when given, otherwise the
/// directory the user is standing in.
///
/// Thirteen call sites open-coded this, which meant thirteen chances for one of
/// them to resolve the workspace differently from the boundary the run is checked
/// against.
fn workspace(cwd: Option<PathBuf>) -> Result<PathBuf, String> {
    match cwd {
        Some(path) => Ok(path),
        None => env::current_dir()
            .map_err(|error| format!("HII could not read the current directory: {error}")),
    }
}

fn delegate_legacy(repo: &std::path::Path, args: &[String]) -> Option<Result<i32, String>> {
    let command = first_command(args)?;
    if claimed_from_legacy(args) {
        return None;
    }
    legacy::is_legacy(command).then(|| legacy::run(repo, args))
}

/// Subcommands of an otherwise-legacy family that the Rust CLI now owns.
///
/// `skills` still delegates to the Node surface for its existing behaviour;
/// only the lifecycle verbs are handled natively, so this migrates one verb at
/// a time instead of taking the whole family at once.
fn claimed_from_legacy(args: &[String]) -> bool {
    let Some(index) = first_command_index(args) else {
        return false;
    };
    let Some(command) = args.get(index).map(String::as_str) else {
        return false;
    };
    route::claims_verb(command, first_positional_after(args, index))
}

/// The first non-flag argument after `index`, skipping any global flag's value.
fn first_positional_after(args: &[String], index: usize) -> Option<&str> {
    let value_flags = value_taking_globals();
    let mut skip_value = false;
    args.iter().skip(index + 1).find_map(|arg| {
        if skip_value {
            skip_value = false;
            return None;
        }
        if arg.starts_with('-') {
            if !arg.contains('=') && value_flags.iter().any(|flag| flag == arg) {
                skip_value = true;
            }
            None
        } else {
            Some(arg.as_str())
        }
    })
}

/// Whether clap can parse this command, so the goal normalizer leaves it alone.
fn is_native_command(command: &str) -> bool {
    route::has_native_surface(command)
}

fn terminal_node(cwd: &std::path::Path, z: u64, now: &str) -> serde_json::Value {
    let id = uuid::Uuid::new_v4().to_string();
    let cwd = cwd.display().to_string();
    let title = std::path::Path::new(&cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(&cwd);
    serde_json::json!({
        "id": id,
        "type": "terminal",
        "x": 120.0,
        "y": 120.0,
        "w": 620.0,
        "h": 320.0,
        "z": z,
        "rotation": 0.0,
        "createdAt": now,
        "updatedAt": now,
        "object": {
            "kind": "terminal",
            "owner": "human",
            "status": "ready",
            "source": "HII CLI Runtime terminal command",
            "capabilityId": "hii.terminal.shell",
            "audit": [{ "ts": now, "actor": "human", "action": format!("created explicit native shell terminal at {cwd}") }]
        },
        "payload": {
            "title": format!("terminal · {title}"),
            "job": "shell",
            "cwd": cwd,
            "status": "ready",
            "role": "operator-terminal",
            "terminalMode": "shell",
            "scope": "human-controlled local shell",
            "sessionId": uuid::Uuid::new_v4().to_string(),
            "lines": []
        }
    })
}

fn open_hii_desktop() -> bool {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").args(["-a", "HII"]).status();
    #[cfg(windows)]
    let status = Command::new("cmd")
        .args(["/C", "start", "", "HII"])
        .status();
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let status = Command::new("xdg-open").arg("hii://space").status();
    status.is_ok_and(|value| value.success())
}

fn create_space_terminal(
    directory: Option<PathBuf>,
    open: bool,
    json_output: bool,
) -> Result<(), String> {
    let directory = workspace(directory)?
        .canonicalize()
        .map_err(|error| format!("terminal working directory is unavailable: {error}"))?;
    if !directory.is_dir() {
        return Err(format!(
            "terminal working directory is not a directory: {}",
            directory.display()
        ));
    }
    let snapshot = hii_core::runtime_space_snapshot(None)?;
    let mut document = snapshot.document.clone();
    let now = chrono::Utc::now().to_rfc3339();
    let z = document
        .get("nextZ")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    let node = terminal_node(&directory, z, &now);
    let node_id = node
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    document
        .get_mut("nodes")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "Runtime Space does not contain a node collection".to_string())?
        .push(node.clone());
    document["nextZ"] = serde_json::Value::from(z + 1);
    document["updatedAt"] = serde_json::Value::String(now);
    let updated = hii_core::runtime_space_apply(hii_core::runtime::RuntimeSpaceApplyV1 {
        version: 1,
        space_id: Some(snapshot.space_id.clone()),
        expected_sequence: snapshot.sequence,
        actor: hii_core::runtime::IdentityRefV1 {
            id: "human:local".into(),
            kind: "human".into(),
        },
        authority_grant_id: None,
        run_id: None,
        idempotency_key: format!("cli:terminal:{node_id}"),
        document,
    })?;
    let launched = open && open_hii_desktop();
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 1,
                "spaceId": updated.space_id,
                "sequence": updated.sequence,
                "node": node,
                "desktopLaunched": launched
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        println!("Created shell terminal in Space `{}`", updated.space_id);
        println!("cwd: {}", directory.display());
        println!("object: {node_id}");
        if open && !launched {
            eprintln!(
                "HII desktop could not be opened automatically; the terminal object is saved."
            );
        } else if !open {
            println!("open: hii terminal --open {}", directory.display());
        }
    }
    Ok(())
}

fn context_command(
    paths: &AppPaths,
    cwd: Option<PathBuf>,
    action: ContextCommand,
) -> Result<(), String> {
    use hii_core::context_pack::{self, ContextApproveRequestV1, ContextCompileRequestV1};
    match action {
        ContextCommand::Compile {
            intent,
            space,
            selections,
            mode,
            authority,
            budget,
            json,
        } => {
            let pack = context_pack::compile(
                &paths.runtime,
                &ContextCompileRequestV1 {
                    version: 1,
                    space_id: Some(space),
                    workspace_root: Some(
                        cwd.unwrap_or_else(|| paths.repo.clone())
                            .display()
                            .to_string(),
                    ),
                    intent: intent.join(" "),
                    selected_object_ids: selections,
                    excluded_object_ids: Vec::new(),
                    actor: hii_core::runtime::IdentityRefV1 {
                        id: "human:local".into(),
                        kind: "human".into(),
                    },
                    authority,
                    mode,
                    budget_tokens: budget,
                    previous_fingerprint: None,
                },
            )?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?
                );
            } else {
                println!(
                    "{}  {:?}  {:?}  {}/{} tokens  {} items\n{}",
                    pack.id,
                    pack.status,
                    pack.risk.action,
                    pack.budget.used_tokens,
                    pack.budget.maximum_tokens,
                    pack.items.len(),
                    pack.fingerprint
                );
            }
        }
        ContextCommand::Show {
            id,
            fingerprint,
            render,
            json,
        } => {
            let pack = if let Some(fingerprint) = fingerprint {
                context_pack::require_approved(&paths.runtime, &id, &fingerprint)?
            } else {
                context_pack::get(&paths.runtime, &id)?
            };
            if render {
                print!("{}", context_pack::render_for_model(&pack));
            } else if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?
                );
            } else {
                println!(
                    "{}  {:?}  {:?}  {}/{} tokens  {} items\n{}",
                    pack.id,
                    pack.status,
                    pack.risk.action,
                    pack.budget.used_tokens,
                    pack.budget.maximum_tokens,
                    pack.items.len(),
                    pack.fingerprint
                );
            }
        }
        ContextCommand::Approve {
            id,
            fingerprint,
            policy,
            json,
        } => {
            let pack = context_pack::approve(
                &paths.runtime,
                &ContextApproveRequestV1 {
                    version: 1,
                    pack_id: id,
                    fingerprint,
                    approved_by: hii_core::runtime::IdentityRefV1 {
                        id: if policy {
                            "policy:local-readonly"
                        } else {
                            "human:local"
                        }
                        .into(),
                        kind: if policy { "service" } else { "human" }.into(),
                    },
                },
            )?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?
                );
            } else {
                println!("approved {} at {}", pack.id, pack.fingerprint);
            }
        }
        ContextCommand::Search {
            id,
            query,
            limit,
            json,
        } => {
            let pack = context_pack::get(&paths.runtime, &id)?;
            let items = context_pack::search_pack(&pack, &query.join(" "), limit);
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
                );
            } else {
                for item in items {
                    println!(
                        "{}\t{}\t{}",
                        item.context_ref.id, item.item_type, item.title
                    );
                }
            }
        }
    }
    Ok(())
}

fn state_command(space: Option<String>, action: StateCommand) -> Result<(), String> {
    use hii_core::checkpoints;
    let runtime = hii_core::runtime_root()?;
    let current = hii_core::runtime_space_snapshot(space)?;
    let space = &current.space_id;
    let output = match action {
        StateCommand::Save { name, json } => {
            let checkpoint = checkpoints::save(&runtime, space, &name, current.sequence)?;
            if !json {
                println!(
                    "Saved {} as {} in Space {} at sequence {}",
                    checkpoint.name, checkpoint.id, space, checkpoint.source_sequence
                );
                return Ok(());
            }
            serde_json::to_value(checkpoint).map_err(|error| error.to_string())?
        }
        StateCommand::List { json } => {
            let checkpoints = checkpoints::list(&runtime, space)?;
            if !json {
                if checkpoints.is_empty() {
                    println!("No named states in Space {space}.");
                }
                for checkpoint in checkpoints {
                    println!(
                        "{}\t{}\tsequence {}\t{}",
                        checkpoint.id,
                        checkpoint.name,
                        checkpoint.source_sequence,
                        checkpoint.created_at
                    );
                }
                return Ok(());
            }
            serde_json::to_value(checkpoints).map_err(|error| error.to_string())?
        }
        StateCommand::Show { state } => {
            serde_json::to_value(checkpoints::get(&runtime, space, &state)?)
                .map_err(|error| error.to_string())?
        }
        StateCommand::Restore {
            state,
            apply,
            expected_sequence,
        } => {
            if apply {
                let expected = expected_sequence
                    .ok_or("Preview first, then provide --apply --expected-sequence <sequence>")?;
                let (snapshot, safety) = checkpoints::restore(&runtime, space, &state, expected)?;
                serde_json::json!({"applied":true,"spaceId":space,"sequence":snapshot.sequence,"safetyCheckpoint":safety.id,"document":snapshot.document})
            } else {
                serde_json::json!({"applied":false,"preview":checkpoints::preview(&runtime, space, &state)?,"next":"Repeat with --apply --expected-sequence <preview.expectedSequence>. Only canvas state is restored; external files and processes are not rewound."})
            }
        }
        StateCommand::Clear => {
            let safety = checkpoints::save(
                &runtime,
                space,
                &format!(
                    "before-clear-{}",
                    chrono::Utc::now().format("%Y%m%d-%H%M%S")
                ),
                current.sequence,
            )?;
            let mut document = current.document.clone();
            document["nodes"] = serde_json::json!([]);
            document["links"] = serde_json::json!([]);
            document["viewport"] = serde_json::json!({"x":0,"y":0,"zoom":1});
            document["nextZ"] = serde_json::json!(1);
            document["updatedAt"] = serde_json::json!(chrono::Utc::now().to_rfc3339());
            let snapshot = hii_core::runtime_space_apply(hii_core::runtime::RuntimeSpaceApplyV1 {
                version: 1,
                space_id: Some(space.clone()),
                expected_sequence: current.sequence,
                actor: hii_core::runtime::IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                authority_grant_id: None,
                run_id: None,
                idempotency_key: format!("cli:state-clear:{}", hii_core::new_run_id()),
                document,
            })?;
            serde_json::json!({"cleared":true,"spaceId":space,"sequence":snapshot.sequence,"safetyCheckpoint":safety.id,"objects":snapshot.document["nodes"].as_array().map_or(0, Vec::len)})
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn share_command(action: ShareCommand) -> Result<(), String> {
    match action {
        ShareCommand::Create {
            mode,
            objects,
            recipient,
            output,
            json,
        } => {
            let parent = output
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."));
            if !parent.is_dir() {
                return Err(format!(
                    "share output directory does not exist: {}",
                    parent.display()
                ));
            }
            if output.exists() {
                return Err(format!("share output already exists: {}", output.display()));
            }
            let bundle =
                hii_core::runtime_share_create(hii_core::runtime::RuntimeShareRequestV1 {
                    version: 1,
                    space_id: None,
                    mode: mode.into(),
                    object_ids: objects,
                    actor: hii_core::runtime::IdentityRefV1 {
                        id: "human:local".into(),
                        kind: "human".into(),
                    },
                    recipient_id: recipient,
                    authority_grant_id: None,
                })?;
            let bytes = serde_json::to_vec_pretty(&bundle).map_err(|error| error.to_string())?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)
                .map_err(|error| format!("could not create share bundle: {error}"))?;
            file.write_all(&bytes)
                .and_then(|_| file.write_all(b"\n"))
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("could not finish share bundle: {error}"))?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "path": output,
                        "bundle": bundle,
                    }))
                    .map_err(|error| error.to_string())?
                );
            } else {
                println!("Created {} share", share_mode_label(bundle.mode));
                println!("bundle: {}", output.display());
                println!("id: {}", bundle.id);
                println!("objects: {}", bundle.objects.len());
                println!("hash: {}", bundle.content_hash);
                println!("not published; no live access was granted");
            }
        }
        ShareCommand::List { json } => {
            let shares = hii_core::runtime_share_list(None)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&shares).map_err(|error| error.to_string())?
                );
            } else if shares.is_empty() {
                println!("No Runtime shares recorded in this Space.");
            } else {
                for share in shares {
                    let state = if share.revoked_at.is_some() {
                        "revoked"
                    } else {
                        "active"
                    };
                    println!(
                        "{}  {:<8} {:<7} {}",
                        share.id,
                        share_mode_label(share.mode),
                        state,
                        share.recipient_id.as_deref().unwrap_or("portable bundle")
                    );
                }
            }
        }
        ShareCommand::Revoke { share, json } => {
            let record =
                hii_core::runtime_share_revoke(hii_core::runtime::RuntimeShareRevokeRequestV1 {
                    version: 1,
                    share_id: share,
                    actor: hii_core::runtime::IdentityRefV1 {
                        id: "human:local".into(),
                        kind: "human".into(),
                    },
                    authority_grant_id: None,
                })?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&record).map_err(|error| error.to_string())?
                );
            } else {
                println!("Revoked share {}", record.id);
                println!("Portable copies already exported remain usable.");
            }
        }
    }
    Ok(())
}

fn share_mode_label(mode: hii_core::runtime::RuntimeShareModeV1) -> &'static str {
    use hii_core::runtime::RuntimeShareModeV1;
    match mode {
        RuntimeShareModeV1::LiveReference => "live",
        RuntimeShareModeV1::Snapshot => "snapshot",
        RuntimeShareModeV1::Fork => "fork",
        RuntimeShareModeV1::Publish => "publish",
        RuntimeShareModeV1::Export => "export",
    }
}

fn login_command(
    paths: &AppPaths,
    provider: Option<&str>,
    name: Option<&str>,
    email: Option<&str>,
    device_name: Option<&str>,
) -> Result<String, String> {
    let provider = provider.unwrap_or("account").trim().to_ascii_lowercase();
    let store = identity::IdentityStore::open(paths);
    match provider.as_str() {
        "account" | "web" => {
            let code = account::read_link_code()?;
            let device_name = device_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(account::default_device_name);
            let linked = account::link(paths, &code, &device_name)?;
            Ok(format!(
                "HII account connected\nuser: {}\ncomputer: {}\nworkspaces: {}\nstate: {}",
                linked.handle.as_deref().unwrap_or("connected account"),
                device_name,
                linked
                    .workspace_count
                    .map(|count| count.to_string())
                    .unwrap_or_else(|| "available after refresh".into()),
                paths.runtime.join("account/device.json").display()
            ))
        }
        "local" | "hii" => {
            let fallback_name = env::var("USER").unwrap_or_else(|_| "local operator".into());
            let identity = store.create_or_update(name.unwrap_or(&fallback_name), email)?;
            Ok(format!(
                "Local HII login ready\nuser: {}\nid: {}\nstate: {}",
                identity.name,
                identity.id,
                store.path().display()
            ))
        }
        "status" => {
            let local = match store.current()? {
                Some(identity) => format!(
                    "Local identity\nuser: {}\nid: {}\nstate: {}",
                    identity.name,
                    identity.id,
                    store.path().display()
                ),
                None => "Local identity\nstate: not created".into(),
            };
            Ok(format!("{}\n\n{}", account::status(paths)?, local))
        }
        "clear" => {
            if store.clear()? {
                Ok("Cleared the local HII login. Provider logins were not changed.".into())
            } else {
                Ok("No local HII login was present.".into())
            }
        }
        "account-logout" | "web-logout" => {
            if account::logout(paths)? {
                Ok("Cleared this computer's local HII account link. Revoke the computer from your web account to invalidate its server credential immediately.".into())
            } else {
                Ok("This computer had no local HII account link.".into())
            }
        }
        "codex" | "openai" | "claude" | "anthropic" => {
            agents::AgentManager::new(paths).login(&provider)
        }
        _ => Err("login provider must be account, local, status, clear, account-logout, codex, or claude".into()),
    }
}

fn command_suggestion(args: &[String]) -> Option<(String, &'static str)> {
    let typed = first_command(args)?;
    if is_native_command(typed) || legacy::is_legacy(typed) || typed.len() < 3 {
        return None;
    }
    route::all_names()
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
    // `mcp` and `acp-serve`. An ambient environment variable should not
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

    /// The `skills` family is split between two implementations, so the carve-out
    /// has to be exact: the lifecycle verbs must reach the Rust CLI, and
    /// everything else must keep reaching the Node surface that still owns it.
    #[test]
    fn only_lifecycle_verbs_are_claimed_from_the_legacy_skills_family() {
        let words =
            |line: &str| -> Vec<String> { line.split_whitespace().map(str::to_string).collect() };
        for claimed in [
            "skills promote foo",
            "skills reject foo",
            "skills lifecycle",
        ] {
            assert!(
                claimed_from_legacy(&words(claimed)),
                "`hii {claimed}` must be handled natively"
            );
        }
        for delegated in ["skills", "skills list", "skill report", "knowledge search"] {
            assert!(
                !claimed_from_legacy(&words(delegated)),
                "`hii {delegated}` must keep reaching the legacy surface"
            );
        }
        // Flags must not shift which word is read as the subcommand.
        assert!(claimed_from_legacy(&words("skills --json lifecycle")));
    }

    #[test]
    fn context_pack_verbs_are_native_even_after_global_flag_values() {
        let words =
            |line: &str| -> Vec<String> { line.split_whitespace().map(str::to_string).collect() };
        assert!(claimed_from_legacy(&words(
            "--cwd /Users/ummi/hii context compile continue"
        )));
        assert!(claimed_from_legacy(&words("context show ctx_1")));
        assert!(!claimed_from_legacy(&words("context --json")));
    }

    #[test]
    fn doctor_interactive_is_a_repo_resolved_machine_check() {
        let repo = TempRepo::new();
        let paths = AppPaths {
            repo: repo.path().to_path_buf(),
            runtime: repo.path().join("runtime"),
        };

        assert!(matches!(
            Cli::try_parse_from(["hii", "doctor", "interactive"])
                .expect("doctor interactive parses")
                .command,
            Some(Commands::Doctor {
                action: Some(DoctorCommand::Interactive { real: false })
            })
        ));
        assert!(matches!(
            Cli::try_parse_from(["hii", "doctor", "interactive", "--real"])
                .expect("doctor interactive --real parses")
                .command,
            Some(Commands::Doctor {
                action: Some(DoctorCommand::Interactive { real: true })
            })
        ));
        assert_eq!(
            interactive_doctor_script(&paths),
            repo.path().join("scripts/hii-cli-interactive-smoke.mjs")
        );
    }

    /// Subcommands are registered in two places: the clap `Commands` enum and
    /// `is_native_command`. A command missing from the latter is silently
    /// rewritten into `hii run <command>`, which launches a real agent goal
    /// loop instead of the subcommand. This asserts the two stay in sync.
    #[test]
    fn every_clap_subcommand_is_a_native_command() {
        use clap::CommandFactory;
        for subcommand in Cli::command().get_subcommands() {
            let name = subcommand.get_name();
            assert!(
                is_native_command(name),
                "`{name}` is a clap subcommand but is_native_command() does not know it, so `hii {name}` would be rewritten into `hii run {name}`"
            );
        }
    }

    #[test]
    fn multi_system_commands_are_native_bindings() {
        assert!(is_native_command("systems"));
        assert!(is_native_command("ecosystem"));
        assert!(is_native_command("on"));
    }

    #[test]
    fn default_system_capabilities_are_os_specific() {
        let windows = default_system_capabilities("windows", false);
        assert!(windows.contains(&"powershell".to_string()));
        assert!(windows.contains(&"windows".to_string()));

        let mac = default_system_capabilities("macos", false);
        assert!(mac.contains(&"applescript".to_string()));
        assert!(mac.contains(&"windows".to_string()));
    }

    /// The routing table and the clap surface are two descriptions of the same
    /// thing, so they must agree in both directions: every clap subcommand is a
    /// native route, every native route is a clap subcommand, and what `--help`
    /// hides is exactly what the table calls Extended.
    #[test]
    fn the_clap_surface_matches_the_routing_table() {
        use clap::CommandFactory;
        let command = Cli::command();
        let mut from_clap: Vec<(String, bool)> = command
            .get_subcommands()
            .map(|sub| (sub.get_name().to_string(), sub.is_hide_set()))
            .collect();
        from_clap.sort();

        for (name, hidden) in &from_clap {
            let entry = route::lookup(name)
                .unwrap_or_else(|| panic!("`hii {name}` is a clap subcommand with no route entry"));
            assert!(
                route::has_native_surface(name),
                "`hii {name}` is implemented in Rust but the table sends it to Node"
            );
            if entry.group == route::Group::Internal {
                assert!(
                    *hidden || name == "help",
                    "`hii {name}` is a machine-facing entrypoint and must not be advertised"
                );
                continue;
            }
            let extended = entry.visibility == route::Visibility::Extended;
            assert_eq!(
                *hidden,
                extended,
                "`hii {name}`: table says {:?} but --help {}",
                entry.visibility,
                if *hidden { "hides it" } else { "shows it" }
            );
        }

        let clap_names: Vec<&str> = from_clap.iter().map(|(name, _)| name.as_str()).collect();
        for entry in route::ROUTES {
            // `agent`/`receipt` are clap aliases, and `help` is clap's own
            // builtin; none of them appear as subcommands in their own right.
            if !route::has_native_surface(entry.name)
                || matches!(entry.name, "agent" | "receipt" | "help")
            {
                continue;
            }
            assert!(
                clap_names.contains(&entry.name),
                "`{}` is routed native but no clap subcommand answers it",
                entry.name
            );
        }
    }

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
    fn usefulness_benchmark_is_native_and_parses_validation_mode() {
        let args = vec![
            "hii".into(),
            "usefulness".into(),
            "benchmark".into(),
            "--validate-only".into(),
            "--json".into(),
        ];
        assert_eq!(normalize_goal_args(args.clone()), args);
        let cli = Cli::try_parse_from(args).expect("parse usefulness benchmark");
        assert!(matches!(
            cli.command,
            Some(Commands::Usefulness {
                action: UsefulnessCommand::Benchmark {
                    validate_only: true,
                    json: true,
                    ..
                }
            })
        ));
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

    #[test]
    fn named_state_restore_defaults_to_preview_and_routes_natively() {
        assert!(route::has_native_surface("state"));
        let cli =
            Cli::try_parse_from(["hii", "state", "restore", "before edit", "--space", "local"])
                .unwrap();
        assert!(
            matches!(cli.command, Some(Commands::State { space: Some(space), action: StateCommand::Restore { apply: false, expected_sequence: None, .. } }) if space == "local")
        );
        let cli = Cli::try_parse_from([
            "hii",
            "state",
            "restore",
            "before edit",
            "--apply",
            "--expected-sequence",
            "4",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Commands::State {
                action: StateCommand::Restore {
                    apply: true,
                    expected_sequence: Some(4),
                    ..
                },
                ..
            })
        ));
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
    fn presence_status_keeps_the_short_form_and_accepts_json_after_status() {
        let short = Cli::try_parse_from(["hii", "presence", "--json"])
            .expect("parse short presence status");
        assert!(matches!(
            short.command,
            Some(Commands::Presence {
                action: None,
                json: true
            })
        ));

        let explicit = Cli::try_parse_from(["hii", "presence", "status", "--json"])
            .expect("parse explicit presence status");
        assert!(matches!(
            explicit.command,
            Some(Commands::Presence {
                action: Some(PresenceCommand::Status),
                json: true
            })
        ));
    }

    #[test]
    fn terminal_is_a_native_runtime_command_with_explicit_shell_authority() {
        let cli =
            Cli::try_parse_from(["hii", "terminal", "/tmp", "--json"]).expect("parse terminal");
        assert!(matches!(
            cli.command,
            Some(Commands::Terminal {
                directory: Some(_),
                open: false,
                json: true
            })
        ));
        let node = terminal_node(std::path::Path::new("/tmp"), 7, "2026-01-01T00:00:00Z");
        assert_eq!(node["payload"]["terminalMode"], "shell");
        assert_eq!(node["object"]["capabilityId"], "hii.terminal.shell");
        assert_eq!(node["z"], 7);
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
    fn run_parses_repeatable_context_sources() {
        let cli = Cli::try_parse_from([
            "hii",
            "run",
            "inspect this",
            "--context-source",
            "nsworkspace:frontmost-app:Rhino",
            "--context-source",
            "app-scripting:document-path:/tmp/tower.3dm",
        ])
        .expect("parse invocation context");
        assert!(matches!(
            cli.command,
            Some(Commands::Run { context_sources, .. })
                if context_sources == [
                    "nsworkspace:frontmost-app:Rhino",
                    "app-scripting:document-path:/tmp/tower.3dm"
                ]
        ));
    }

    #[test]
    fn mirror_commands_parse_strength_authority_and_machine_output_independently() {
        let show = Cli::try_parse_from([
            "hii",
            "mirror",
            "show",
            "--strength",
            "light",
            "--authority",
            "suggest",
            "--json",
        ])
        .expect("parse mirror show");
        assert!(matches!(
            show.command,
            Some(Commands::Mirror {
                action: MirrorCommand::Show {
                    strength: mirror::MirrorStrength::Light,
                    authority: mirror::MirrorAuthority::Suggest,
                    json: true,
                }
            })
        ));

        let run = Cli::try_parse_from([
            "hii",
            "mirror",
            "run",
            "prepare",
            "the",
            "brief",
            "--strength",
            "strong",
            "--authority",
            "prepare",
            "--verify",
            "test -f brief.md",
            "--jsonl",
        ])
        .expect("parse mirror run");
        assert!(matches!(
            run.command,
            Some(Commands::Mirror {
                action: MirrorCommand::Run {
                    goal,
                    strength: mirror::MirrorStrength::Strong,
                    authority: mirror::MirrorAuthority::Prepare,
                    verify,
                    json: false,
                    jsonl: true,
                    ..
                }
            }) if goal == ["prepare", "the", "brief"] && verify == ["test -f brief.md"]
        ));
    }

    #[test]
    fn mirror_is_a_native_inspectable_route_without_expanding_the_core_map() {
        let route = route::lookup("mirror").expect("mirror route");
        assert_eq!(route.surface, route::Surface::Native);
        assert_eq!(route.visibility, route::Visibility::Extended);
        assert!(route::full_command_list().contains("mirror"));
    }

    #[test]
    fn run_structured_output_modes_conflict() {
        assert!(Cli::try_parse_from(["hii", "run", "--json", "--jsonl", "inspect"]).is_err());
        assert!(Cli::try_parse_from(["hii", "run", "--json", "--verbose", "inspect"]).is_err());
    }

    #[test]
    fn parses_local_hii_login() {
        let cli = Cli::try_parse_from(["hii", "login", "local", "--name", "Ummi"])
            .expect("parse local login");
        assert!(matches!(
            cli.command,
            Some(Commands::Login {
                provider: Some(provider),
                name: Some(name),
                email: None,
                device_name: None,
            }) if provider == "local" && name == "Ummi"
        ));
    }

    #[test]
    fn account_is_the_default_hii_login() {
        let cli = Cli::try_parse_from(["hii", "login"]).expect("parse account login");
        assert!(matches!(
            cli.command,
            Some(Commands::Login {
                provider: None,
                name: None,
                email: None,
                device_name: None,
            })
        ));
    }

    #[test]
    fn parses_pipe_intent_with_explicit_authority() {
        let cli = Cli::try_parse_from([
            "hii",
            "pipe",
            "send",
            "an",
            "iMessage",
            "--authority",
            "external-commit",
            "--json",
        ])
        .expect("parse pipe");
        assert!(matches!(
            cli.command,
            Some(Commands::Pipe {
                intent,
                authority: Some(authority),
                json: true,
                ..
            }) if intent == ["send", "an", "iMessage"] && authority == "external-commit"
        ));
    }

    #[test]
    fn parses_service_request_as_a_bounded_fulfillment_contract() {
        let cli = Cli::try_parse_from([
            "hii",
            "service",
            "request",
            "prepare",
            "a",
            "project",
            "brief",
            "--capability",
            "hii.agent.workspace_run",
            "--authority",
            "workspace",
            "--done-when",
            "the brief exists and its checks pass",
            "--proof",
            "brief validator passes",
            "--json",
        ])
        .expect("parse service request");
        assert!(matches!(
            cli.command,
            Some(Commands::Service {
                action: ServiceCommand::Request {
                    need,
                    capability: Some(capability),
                    authority: Some(authority),
                    done_when,
                    proof,
                    json: true,
                }
            }) if need == ["prepare", "a", "project", "brief"]
                && capability == "hii.agent.workspace_run"
                && authority == "workspace"
                && done_when == "the brief exists and its checks pass"
                && proof == ["brief validator passes"]
        ));
    }

    #[test]
    fn parses_project_create_with_explicit_pricing_basis() {
        let cli = Cli::try_parse_from([
            "hii",
            "project",
            "create",
            "Community",
            "Workshop",
            "--budget",
            "1250000.00",
            "--base-hours",
            "1400",
            "--blended-rate",
            "185.00",
            "--options",
            "4",
            "--json",
        ])
        .expect("parse project creation");
        assert!(matches!(
            cli.command,
            Some(Commands::Project {
                action: ProjectCommand::Create {
                    name,
                    budget: Some(budget),
                    base_hours: 1400,
                    blended_rate,
                    options: 4,
                    json: true,
                    ..
                }
            }) if name == ["Community", "Workshop"]
                && budget == "1250000.00"
                && blended_rate == "185.00"
        ));
        assert!(Cli::try_parse_from(["hii", "project", "create", "Missing basis"]).is_err());
    }

    #[test]
    fn parses_reviewed_skill_run_and_direct_run_skill_selection() {
        let skill = Cli::try_parse_from([
            "hii",
            "skills",
            "run",
            "build-hii-knowledge-slice",
            "verify",
            "the",
            "knowledge",
            "loop",
            "--verify",
            "npm run hii:knowledge:check",
        ])
        .expect("parse skill run");
        assert!(matches!(
            skill.command,
            Some(Commands::Skills {
                action: SkillsCommand::Run { id, goal, verify, .. }
            }) if id == "build-hii-knowledge-slice"
                && goal == ["verify", "the", "knowledge", "loop"]
                && verify == ["npm run hii:knowledge:check"]
        ));

        let run = Cli::try_parse_from([
            "hii",
            "run",
            "inspect",
            "--skill",
            "build-hii-knowledge-slice",
        ])
        .expect("parse run skill");
        assert!(matches!(
            run.command,
            Some(Commands::Run { skills, .. })
                if skills == ["build-hii-knowledge-slice"]
        ));
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
            parse_slash_command("/overview"),
            Some(SlashCommand::Overview)
        );
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
            Some(SlashCommand::Thinking(Some("stream".into())))
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
        assert_eq!(
            parse_slash_command("/copy"),
            Some(SlashCommand::Copy(String::new()))
        );
        assert_eq!(
            parse_slash_command("/copy code"),
            Some(SlashCommand::Copy("code".into()))
        );
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
