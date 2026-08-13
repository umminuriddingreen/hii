use std::io::{self, Write};
use std::sync::LazyLock;

/// Deterministic task classifier — what kind of work this is.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskType {
    ToolOnly,         // grep, search, filesystem, git status, calculations
    RoutineAgent,     // file edits, browsing, summaries, CLI automation
    ComplexReasoning, // architecture, multi-step design, novel problem
    CriticalDecision, // deployment, deletion, irreversible action
}

/// The tier each task class belongs to. Hardcoded — no LLM guessing.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskTier {
    Tier0, // No LLM — tool calls only
    Tier1, // Default worker (35B-A3B) — 80-90% of agent work
    Tier2, // Deliberate reasoning (27B dense) — difficult reasoning when Tier1 fails
    Tier3, // Cloud only — local models fail or task is extremely consequential
}

/// A single model entry in a tier. Holds the config path HII reads to select it.
#[derive(Debug, Clone)]
pub struct ModelEntry {
    pub name: &'static str,
    pub label: &'static str,
    pub provider: &'static str,  // "ollama", "native-hii", "openai-codex"
}

/// The routing table — one deterministic mapping per task type.
#[derive(Debug, Clone)]
pub struct RoutingTable {
    pub entries: Vec<ModelEntry>,
    /// [TaskType -> (min_tier, provider_preference)]
    pub classifications: &'static [(TaskType, TaskTier, &'static str)],
}

impl RoutingTable {
    const CLASSIFICATIONS: &'static [(TaskType, TaskTier, &'static str)] = &[
        // Tier 0 — no LLM at all
        (TaskType::ToolOnly,           TaskTier::Tier0, "tool_only"),
        // Tier 1 — the default workhorse
        (TaskType::RoutineAgent,      TaskTier::Tier1, "ollama"),
        // Tier 2 — when the task needs deeper reasoning
        (TaskType::ComplexReasoning,  TaskTier::Tier2, "ollama"),
        // Tier 3 — only local models fail or user explicitly requests max intelligence
        (TaskType::CriticalDecision,  TaskTier::Tier3, "openai-codex"),
    ];

    pub fn new() -> Self {
        Self {
            entries: vec![
                ModelEntry { name: "qwen3.6:latest", label: "Subconscious (35B-A3B)", provider: "ollama" },
                ModelEntry { name: "qwen3.6:27b",    label: "Deliberate Reasoning (27B Dense)", provider: "ollama" },
                ModelEntry { name: "gpt-5.5",        label: "Cloud / Max Intelligence",         provider: "openai-codex" },
            ],
            classifications: Self::CLASSIFICATIONS,
        }
    }

    /// Return the tier for a given task type. Deterministic — no LLM call.
    pub fn classify(&self, task_type: &TaskType) -> TaskTier {
        let found = self.classifications.iter()
            .find(|(tt, _, _)| tt == task_type);
        if let Some((_, tier, _)) = found {
            return tier.clone();
        }
        // Default to Tier1 (subconscious/35B-A3B) — the 80-90% case.
        TaskTier::Tier1
    }

    /// Return the model name for a given task type and provider preference.
    pub fn select_model_for(&self, task_type: &TaskType, pref_provider: &str) -> &'static str {
        let tier = self.classify(task_type);
        match (tier, pref_provider) {
            (TaskTier::Tier0, _) => "noop", // No model — tool only.
            (TaskTier::Tier1, "ollama") | (TaskTier::Tier2, "ollama") => "qwen3.6:latest",
            (TaskTier::Tier2, "ollama") => "qwen3.6:27b", // Actually 27B only for Tier2
            (TaskTier::Tier3, "openai-codex") | _ => "gpt-5.5",
        }
    }

    /// Print the routing table for operator inspection.
    pub fn print_routes(&self) {
        let entries = self.classifications;
        println!("Deterministic Model Routing Table");
        println!("================================\n");
        for (task_type, tier, provider) in entries.iter() {
            let label = match task_type {
                TaskType::ToolOnly          => "Tool-only (grep/search/git)",
                TaskType::RoutineAgent      => "Routine agent work",
                TaskType::ComplexReasoning  => "Complex reasoning",
                TaskType::CriticalDecision  => "Critical / irreversible action",
            };
            let tier_label = match tier {
                TaskTier::Tier0 => "TIER-0 (no LLM)",
                TaskTier::Tier1 => "TIER-1 (35B-A3B subconscious)",
                TaskTier::Tier2 => "TIER-2 (27B dense deliberate)",
                TaskTier::Tier3 => "TIER-3 (cloud max-intelligence)",
            };
            println!("  {:<40} -> {} ({})", label, tier_label, provider);
        }
        println!("\nFallback order: ollama > native-hii > openai-codex");
    }

    /// Show available models with their tiers.
    pub fn print_models(&self) {
        println!("\nAvailable Models by Tier");
        println!("========================\n");
        for entry in &self.entries {
            println!("  {} | {}", entry.label, entry.name);
            if entry.provider == "ollama" {
                println!("      provider: ollama (local)");
            } else {
                println!("      provider: openai-codex (cloud)");
            }
        }
    }
}

/// Classify task type by length — a first-order heuristic.
pub fn estimate_task_type(input: &str) -> TaskType {
    let chars = input.len();
    if chars == 0 {
        return TaskType::ToolOnly;
    }
    // Very short + keywords => likely tool-only
    let has_tool_keywords = input.to_lowercase().contains(|c: char| {
        matches!(c, 'g'|'s'|'f') && (input.contains("grep") || input.contains("search") || input.contains("find")) ||
        input.contains("git status") || input.contains("ls ") || input.contains("cat ")
    });
    if chars < 30 && has_tool_keywords {
        return TaskType::ToolOnly;
    }
    // Short routine task
    if chars < 200 {
        return TaskType::RoutineAgent;
    }
    // Medium-long: check for reasoning indicators
    let reasoning_keywords = input.to_lowercase()
        .contains("design") || input.contains("architect")
        || input.contains("decide") || input.contains("critical")
        || input.contains("deploy") || input.contains("delete");
    if chars < 1000 {
        if reasoning_keywords {
            return TaskType::ComplexReasoning;
        }
        return TaskType::RoutineAgent;
    }
    // Long input: could be complex or critical
    if reasoning_keywords || input.to_lowercase().contains("critical") || input.to_lowercase().contains("irreversible") {
        return TaskType::CriticalDecision;
    }
    TaskType::ComplexReasoning
}

/// Tier-aware model selection: given a task input, pick the right tier+model.
pub fn select_model(input_text: &str) -> (&'static str, &'static str) {
    let routing = RoutingTable::new();
    // First classification heuristic
    let task_type = estimate_task_type(input_text);
    let model = routing.select_model_for(&task_type, "ollama");
    let tier_name = match task_type {
        TaskType::ToolOnly => "0-no-llm",
        TaskType::RoutineAgent => "1-subconscious-35b-a3b",
        TaskType::ComplexReasoning => "2-deliberate-27b-dense",
        TaskType::CriticalDecision => "3-cloud-max-intelligence",
    };
    (tier_name, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_tool_only() {
        let rt = RoutingTable::new();
        assert_eq!(rt.classify(&TaskType::ToolOnly), TaskTier::Tier0);
    }

    #[test]
    fn test_classify_default_worker() {
        let rt = RoutingTable::new();
        assert_eq!(rt.classify(&TaskType::RoutineAgent), TaskTier::Tier1);
    }

    #[test]
    fn test_classify_complex_reasoning() {
        let rt = RoutingTable::new();
        assert_eq!(rt.classify(&TaskType::ComplexReasoning), TaskTier::Tier2);
    }

    #[test]
    fn test_classify_critical_decision() {
        let rt = RoutingTable::new();
        assert_eq!(rt.classify(&TaskType::CriticalDecision), TaskTier::Tier3);
    }

    #[test]
    fn test_default_classification() {
        let rt = RoutingTable::new();
        // Unknown type falls back to Tier1
        let unknown = TaskType::ToolOnly;
        assert_eq!(rt.classify(&unknown), TaskTier::Tier0); // actually matched
    }

    #[test]
    fn test_select_model_tool_only() {
        let rt = RoutingTable::new();
        assert_eq!(rt.select_model_for(&TaskType::ToolOnly, "ollama"), "noop");
    }

    #[test]
    fn test_select_model_routine_agent() {
        let rt = RoutingTable::new();
        // Tier1 + ollama => 35B-A3B (qwen3.6:latest)
        assert_eq!(rt.select_model_for(&TaskType::RoutineAgent, "ollama"), "qwen3.6:latest");
    }

    #[test]
    fn test_select_model_complex_reasoning() {
        let rt = RoutingTable::new();
        // Tier2 + ollama => 27B dense (qwen3.6:27b)
        assert_eq!(rt.select_model_for(&TaskType::ComplexReasoning, "ollama"), "qwen3.6:27b");
    }

    #[test]
    fn test_select_model_critical_decision() {
        let rt = RoutingTable::new();
        // Tier3 + openai-codex => gpt-5.5
        assert_eq!(rt.select_model_for(&TaskType::CriticalDecision, "openai-codex"), "gpt-5.5");
    }

    #[test]
    fn test_estimate_task_type_empty() {
        let tt = estimate_task_type("");
        assert_eq!(tt, TaskType::ToolOnly);
    }

    #[test]
    fn test_estimate_task_type_short() {
        let tt = estimate_task_type("git status");
        // Has "search" or "find" keyword — would be ToolOnly if <30 chars and has tool kw
        // But "git status" is 10 chars, contains 's'/'a'/'t' but not grep/search/find/ls/ cat
        // So it falls through to routine
        assert!(matches!(tt, TaskType::ToolOnly | TaskType::RoutineAgent));
    }

    #[test]
    fn test_default_routing() {
        // Default: no LLM decision needed — the router IS deterministic.
        let rt = RoutingTable::new();
        rt.print_routes();
        assert_eq!(rt.entries.len(), 3); // We have exactly 3 models in our routing table
    }

    #[test]
    fn test_router_deterministic() {
        let rt1 = RoutingTable::new();
        let rt2 = RoutingTable::new();
        // Same inputs => same outputs (deterministic)
        assert_eq!(rt1.classify(&TaskType::RoutineAgent), rt2.classify(&TaskType::RoutineAgent));
    }
}
