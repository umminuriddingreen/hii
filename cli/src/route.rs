// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! The one place that decides what a typed command means.
//!
//! Routing used to be spread across four hand-maintained lists — `LEGACY_COMMANDS`,
//! `is_native_command`, `claimed_from_legacy`, and the typo-suggestion array — which
//! drifted against each other. `hii skills` was named in `is_native_command` and in
//! `--help` while still resolving to the Node surface, and `terminal` was rescued from
//! the same fate only by a hardcoded `if`. Every one of those questions is now answered
//! by [`ROUTES`], and `routing_is_unambiguous` fails the build if an entry answers two
//! ways.

/// Which implementation owns a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    /// The Rust clap surface owns the whole family.
    Native,
    /// The Node compatibility surface owns the whole family.
    Delegated,
    /// Delegated, except these verbs, which the Rust surface has already taken.
    ///
    /// This is how a family migrates one verb at a time instead of all at once.
    Split(&'static [&'static str]),
}

/// Where a command appears in `--help`.
///
/// `Core` is the surface a new user should see: the bounded-work loop and the
/// commands that unblock it. Everything else is real but is infrastructure, and a
/// 77-command wall of text is how the four commands that matter get lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Core,
    Extended,
}

/// The `hii help --all` section a command is listed under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Work,
    Context,
    Infra,
    Tools,
    Build,
    /// Machine-facing entrypoints; never advertised to a human.
    Internal,
}

impl Group {
    pub const ORDER: &'static [Group] = &[
        Group::Work,
        Group::Context,
        Group::Infra,
        Group::Tools,
        Group::Build,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Group::Work => "Work",
            Group::Context => "Context",
            Group::Infra => "Infrastructure",
            Group::Tools => "Tools",
            Group::Build => "Build",
            Group::Internal => "Internal",
        }
    }
}

pub struct Route {
    pub name: &'static str,
    pub surface: Surface,
    pub visibility: Visibility,
    pub group: Group,
    pub blurb: &'static str,
}

const fn native(
    name: &'static str,
    visibility: Visibility,
    group: Group,
    blurb: &'static str,
) -> Route {
    Route {
        name,
        surface: Surface::Native,
        visibility,
        group,
        blurb,
    }
}

const fn split(
    name: &'static str,
    native_verbs: &'static [&'static str],
    visibility: Visibility,
    group: Group,
    blurb: &'static str,
) -> Route {
    Route {
        name,
        surface: Surface::Split(native_verbs),
        visibility,
        group,
        blurb,
    }
}

const fn delegated(
    name: &'static str,
    visibility: Visibility,
    group: Group,
    blurb: &'static str,
) -> Route {
    Route {
        name,
        surface: Surface::Delegated,
        visibility,
        group,
        blurb,
    }
}

use Group::{Build, Context, Infra, Internal, Tools, Work};
use Visibility::{Core, Extended};

/// The split verbs that the Rust surface has taken out of a delegated family.
///
/// Keep this beside the table it annotates: `context compile` and `skills promote`
/// are native, every other verb of those families is not.
pub const CONTEXT_NATIVE_VERBS: &[&str] = &["compile", "show", "approve", "search"];
pub const SKILLS_NATIVE_VERBS: &[&str] = &["promote", "reject", "lifecycle", "record-use", "run"];

/// Every command `hii` answers to, and who answers it.
pub const ROUTES: &[Route] = &[
    // ---- the bounded-work loop: what a new user should see first ----
    delegated("home", Core, Context, "show the compact current coordinate"),
    native(
        "run",
        Core,
        Work,
        "complete a goal inside a bounded workspace",
    ),
    native(
        "ask",
        Core,
        Work,
        "stream one answer from the fastest local model",
    ),
    delegated("work", Core, Work, "show and advance the work queue"),
    delegated("task", Core, Work, "capture a task into the queue"),
    delegated("now", Core, Work, "show what to do next"),
    delegated("chat", Core, Work, "open the conversational surface"),
    delegated("check", Core, Build, "typecheck: the inner fix loop"),
    delegated("ship", Core, Build, "validate and commit locally"),
    native(
        "proof",
        Core,
        Work,
        "inspect the latest or selected run receipt",
    ),
    native(
        "stream",
        Core,
        Work,
        "watch the continuously legible run stream",
    ),
    native("board", Core, Work, "local kanban/todo board"),
    native(
        "status",
        Core,
        Infra,
        "show the local workspace-agent state",
    ),
    native(
        "doctor",
        Core,
        Infra,
        "check CLI, workspace, Git, and model readiness",
    ),
    native(
        "find",
        Core,
        Tools,
        "search every local capability HII already owns",
    ),
    native(
        "models",
        Core,
        Infra,
        "list locally installed Ollama models",
    ),
    delegated(
        "model",
        Core,
        Infra,
        "fully manage the HII Native model backend",
    ),
    delegated(
        "open",
        Core,
        Infra,
        "open the HII desktop app, local web, or canonical site",
    ),
    delegated(
        "ui",
        Core,
        Infra,
        "control HII desktop and local web surfaces",
    ),
    delegated(
        "app",
        Core,
        Infra,
        "open or inspect the installed HII desktop app",
    ),
    native(
        "providers",
        Core,
        Infra,
        "show local, Codex, and Claude account access",
    ),
    native(
        "login",
        Core,
        Infra,
        "connect an existing Codex or Claude plan",
    ),
    native(
        "clean",
        Core,
        Infra,
        "preview or apply a restorable cleanup",
    ),
    // ---- native, but infrastructure ----
    native("agent", Extended, Work, "alias for `run`"),
    native("receipt", Extended, Work, "alias for `proof`"),
    native(
        "terminal",
        Extended,
        Tools,
        "create a native shell terminal object",
    ),
    native(
        "share",
        Extended,
        Context,
        "create and inspect object shares",
    ),
    split(
        "context",
        CONTEXT_NATIVE_VERBS,
        Extended,
        Context,
        "compile, inspect, approve, and search context packs",
    ),
    native(
        "apps",
        Extended,
        Tools,
        "list, register, and launch applications",
    ),
    native(
        "presence",
        Extended,
        Context,
        "show continuity and authority boundary",
    ),
    native(
        "link",
        Extended,
        Infra,
        "HII Link contact card and WireGuard mesh",
    ),
    native("systems", Extended, Infra, "manage enrolled Macs and PCs"),
    native(
        "network",
        Extended,
        Infra,
        "operate HII-owned device networking",
    ),
    native(
        "ecosystem",
        Extended,
        Infra,
        "project CLI-owned runtime resources",
    ),
    native(
        "on",
        Extended,
        Infra,
        "run a bounded command against an enrolled system",
    ),
    native(
        "discover",
        Extended,
        Tools,
        "download capability sources from trusted indexes",
    ),
    split(
        "skills",
        SKILLS_NATIVE_VERBS,
        Extended,
        Tools,
        "skill lifecycle: proposed to trusted",
    ),
    native(
        "info",
        Extended,
        Context,
        "capture, inspect, and export information objects",
    ),
    native("web", Extended, Tools, "run governed web intent slices"),
    native(
        "pipe",
        Extended,
        Tools,
        "compile intent into a capability and proof plan",
    ),
    native(
        "usefulness",
        Extended,
        Infra,
        "measure one loop against 20 everyday requests",
    ),
    native(
        "service",
        Extended,
        Infra,
        "match needs to HII-hosted services",
    ),
    native(
        "notify",
        Extended,
        Infra,
        "send and inspect agent notifications",
    ),
    native(
        "project",
        Extended,
        Work,
        "plan, price, triage, and govern projects",
    ),
    native(
        "thread",
        Extended,
        Work,
        "create and resume objective threads",
    ),
    native(
        "interact",
        Extended,
        Work,
        "record one provider-neutral interaction proposal",
    ),
    native(
        "schedule",
        Extended,
        Infra,
        "manage local recurring work through cron",
    ),
    native(
        "tools",
        Extended,
        Tools,
        "inspect and guide autonomous tool creation",
    ),
    // ---- delegated infrastructure ----
    delegated("capture", Extended, Work, "alias for `task`"),
    delegated("loop", Extended, Work, "run a repeating local loop"),
    delegated("health", Extended, Infra, "report local runtime health"),
    delegated(
        "agents",
        Extended,
        Context,
        "show agent adapter coordinates",
    ),
    delegated("agent-context", Extended, Context, "alias for `context`"),
    delegated("og", Extended, Context, "operational graph status"),
    delegated("knowledge", Extended, Context, "local knowledge workspace"),
    delegated("links", Extended, Context, "browser link stream and cache"),
    delegated("feed", Extended, Context, "local activity feed"),
    delegated(
        "pack",
        Extended,
        Context,
        "compartmentalized capability packs",
    ),
    delegated(
        "probe",
        Extended,
        Infra,
        "worktree and legacy runtime probe",
    ),
    delegated("caps", Extended, Infra, "show backend capabilities"),
    delegated("jobs", Extended, Infra, "list and inspect local jobs"),
    delegated("daemon", Extended, Infra, "supervise the local daemon"),
    delegated("instances", Extended, Infra, "list managed instances"),
    delegated(
        "runner",
        Extended,
        Infra,
        "owned runners and the native model runtime",
    ),
    delegated(
        "registry",
        Extended,
        Infra,
        "scan, doctor, export the registry",
    ),
    delegated(
        "space",
        Extended,
        Infra,
        "macOS Space observation and control",
    ),
    delegated(
        "money",
        Extended,
        Infra,
        "turn an idea into a local offer brief",
    ),
    delegated("objects", Extended, Infra, "the governed object interface"),
    delegated("object", Extended, Infra, "alias for `objects`"),
    delegated("sdk", Extended, Tools, "SDK contract smoke check"),
    delegated("console", Extended, Tools, "open a console surface"),
    delegated(
        "bridge",
        Extended,
        Tools,
        "message Codex through the local bridge",
    ),
    delegated("mcp", Extended, Tools, "Codex MCP passthrough"),
    delegated(
        "codex",
        Extended,
        Tools,
        "queue and inspect managed Codex runs",
    ),
    delegated(
        "skill",
        Extended,
        Tools,
        "single-skill authoring and registry",
    ),
    delegated("dev", Extended, Build, "run the Next.js app in development"),
    delegated("build", Extended, Build, "build the Next.js app"),
    delegated("start", Extended, Build, "start the built Next.js app"),
    // ---- machine-facing ----
    native(
        "tools-manifest",
        Extended,
        Internal,
        "print the tool capability manifest as JSON",
    ),
    native(
        "mcp-serve",
        Extended,
        Internal,
        "serve the tool surface as an MCP server",
    ),
    native(
        "acp-serve",
        Extended,
        Internal,
        "serve the ACP handshake over stdio",
    ),
    native(
        "legacy",
        Extended,
        Internal,
        "explicit compatibility-surface escape hatch",
    ),
    native(
        "help",
        Core,
        Internal,
        "print this message or a command's help",
    ),
];

pub fn lookup(command: &str) -> Option<&'static Route> {
    ROUTES.iter().find(|route| route.name == command)
}

/// Whether the Node compatibility surface owns this command by default.
pub fn is_delegated(command: &str) -> bool {
    !matches!(
        lookup(command).map(|route| route.surface),
        None | Some(Surface::Native)
    )
}

/// Whether clap knows this name at all — a fully native family, or a split one
/// whose claimed verbs clap must still be able to parse.
///
/// Distinct from [`is_native`], which asks who owns a *bare* invocation. Conflating
/// the two rewrites `hii context ...` into `hii run context ...`, because the goal
/// normalizer treats any unrecognized first word as prose.
pub fn has_native_surface(command: &str) -> bool {
    matches!(
        lookup(command).map(|route| route.surface),
        Some(Surface::Native | Surface::Split(_))
    )
}

/// Whether the Rust surface owns this specific `command verb` pair.
pub fn claims_verb(command: &str, verb: Option<&str>) -> bool {
    match lookup(command).map(|route| route.surface) {
        Some(Surface::Native) => true,
        Some(Surface::Split(verbs)) => verb.is_some_and(|verb| verbs.contains(&verb)),
        _ => false,
    }
}

/// Every command name, for typo suggestions.
pub fn all_names() -> impl Iterator<Item = &'static str> {
    ROUTES
        .iter()
        .filter(|route| route.group != Group::Internal)
        .map(|route| route.name)
}

pub fn in_group(
    group: Group,
    visibility: Option<Visibility>,
) -> impl Iterator<Item = &'static Route> {
    ROUTES.iter().filter(move |route| {
        route.group == group && visibility.is_none_or(|want| route.visibility == want)
    })
}

/// The `hii help --all` listing, rendered from the table itself so it can never
/// name a command that does not route or omit one that does.
pub fn full_command_list() -> String {
    let mut lines = vec!["Every HII command:".to_string(), String::new()];
    for group in Group::ORDER {
        let mut rows: Vec<&Route> = in_group(*group, None).collect();
        if rows.is_empty() {
            continue;
        }
        rows.sort_by_key(|route| route.name);
        lines.push(format!("{}:", group.title()));
        for route in rows {
            lines.push(format!("  {:<16}{}", route.name, route.blurb));
        }
        lines.push(String::new());
    }
    lines.push("Every command supports `hii <command> --help`.".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The regression this table exists to prevent.
    ///
    /// With routing spread across four lists, `skills` was simultaneously
    /// "native" (per `is_native_command`) and "legacy" (per `LEGACY_COMMANDS`),
    /// and the pre-clap delegation check ran first, so the documented Rust
    /// subcommand was unreachable. One name must resolve exactly one way.
    #[test]
    fn routing_is_unambiguous() {
        let mut seen = HashSet::new();
        for route in ROUTES {
            assert!(
                seen.insert(route.name),
                "`{}` appears twice in ROUTES, so its route depends on iteration order",
                route.name
            );
            // Native and Delegated are mutually exclusive; Split is native for
            // its listed verbs and delegated for everything else, which is one
            // rule, not two answers to the same question.
            match route.surface {
                Surface::Native => assert!(
                    has_native_surface(route.name) && !is_delegated(route.name),
                    "`{}` is Native but does not resolve native",
                    route.name
                ),
                Surface::Delegated => assert!(
                    is_delegated(route.name) && !has_native_surface(route.name),
                    "`{}` is Delegated but clap also claims it",
                    route.name
                ),
                Surface::Split(_) => assert!(
                    is_delegated(route.name) && has_native_surface(route.name),
                    "`{}` is Split but is not reachable on both surfaces",
                    route.name
                ),
            }
        }
    }

    /// A `Split` family that has claimed nothing is just a delegated family
    /// wearing a more complicated type, and a `Split` verb list with a typo
    /// silently sends the verb back to Node.
    #[test]
    fn split_families_actually_claim_verbs() {
        for route in ROUTES {
            if let Surface::Split(verbs) = route.surface {
                assert!(
                    !verbs.is_empty(),
                    "`{}` is Split but claims no verbs; make it Delegated",
                    route.name
                );
                for verb in verbs {
                    assert!(
                        claims_verb(route.name, Some(verb)),
                        "`{} {verb}` is declared native but does not resolve native",
                        route.name
                    );
                }
                assert!(
                    !claims_verb(route.name, None),
                    "bare `{}` must still reach the surface that owns the family",
                    route.name
                );
            }
        }
    }

    /// `hii help --all` is generated from the table, so this asserts the table is
    /// complete rather than that the renderer works.
    #[test]
    fn every_human_command_is_listed_somewhere() {
        let listing = full_command_list();
        for route in ROUTES {
            if route.group == Group::Internal {
                continue;
            }
            assert!(
                listing.contains(route.name),
                "`{}` routes but `hii help --all` never names it",
                route.name
            );
        }
    }

    /// The listing is only complete if the table is. Both surfaces are read
    /// directly so a command added to either one without a route fails here
    /// rather than becoming reachable-but-undocumented (or, for the Node
    /// surface, unreachable: an unrouted name is parsed as prose, not a
    /// command). `objects` was both for as long as the table was hand-checked.
    #[test]
    fn every_reachable_command_has_a_route() {
        let names: HashSet<&str> = ROUTES.iter().map(|route| route.name).collect();

        let node = include_str!("../../scripts/hii-cli.mjs");
        for line in node.lines() {
            let Some(rest) = line.trim().strip_prefix("case \"") else {
                continue;
            };
            let Some(name) = rest.split('"').next() else {
                continue;
            };
            // `--help`/`-h` are flags the Node surface also answers to, not commands.
            if name.starts_with('-') {
                continue;
            }
            assert!(
                names.contains(name),
                "the Node surface answers `hii {name}` but ROUTES never names it, so it is \
                 neither delegated nor listed in `hii help --all`"
            );
        }

        for sub in <crate::Cli as clap::CommandFactory>::command().get_subcommands() {
            let name = sub.get_name();
            assert!(
                names.contains(name),
                "clap parses `hii {name}` but ROUTES never names it, so `hii help --all` \
                 never mentions it"
            );
        }
    }

    /// Core is the first thing a new user reads. It stops being an answer to
    /// "what do I run" the moment it becomes another wall of commands.
    #[test]
    fn the_core_surface_stays_small() {
        let core = ROUTES
            .iter()
            .filter(|route| route.visibility == Visibility::Core)
            .count();
        assert!(
            core <= 22,
            "{core} core commands is a wall of text, not an entry point"
        );
    }
}
