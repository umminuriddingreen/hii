const DESIGN_CONTEXT_PREFIX: &str = "HII NATIVE DESIGN CONTEXT";

const DESIGN_TERMS: &[&str] = &[
    "architect",
    "architecture",
    "brand",
    "concept",
    "diagram",
    "drawing",
    "frontend",
    "graphic",
    "image",
    "interface",
    "layout",
    "poster",
    "presentation",
    "render",
    "spatial",
    "ui",
    "ux",
    "visual",
    "website",
];

pub(crate) fn context_for_request(request: &str, comfy_available: bool) -> Option<String> {
    let normalized = request.to_ascii_lowercase();
    if !DESIGN_TERMS
        .iter()
        .any(|term| contains_term(&normalized, term))
    {
        return None;
    }
    let media = if comfy_available {
        "ComfyUI MCP is available: call server_info first; generate local references or assets when they materially improve the result; iterate against the artifact; retain workflow, prompt, seed, model, and output provenance. Ask before downloads, installs, paid nodes, or external generation."
    } else {
        "If original visual media would materially improve the result, inspect the MCP catalog and local capabilities before substituting decoration or placeholders."
    };
    Some(format!(
        "{DESIGN_CONTEXT_PREFIX}\nDesign is native HII work. Inspect the real subject, audience, content, constraints, precedents, and existing visual system. Make the primary object and one job obvious; use hierarchy, typography, spacing, line, tone, color, and motion to encode meaning. For architecture, pair concept with site, structure, enclosure, climate, light, comfort, material, construction, and human use; label diagrams, calculations, simulations, and measurements honestly.\n\nClose the concept loop. Give every published concept a stable concept id and revision plus a QR code that resolves to its accessible review page; show the short URL beside it as a fallback. The review page must show the current concept, revision/date, assumptions, scope, total project budget, design/media/geometry creation cost, cost basis, contingency, exclusions, and uncertainty instead of presenting an estimate as a bid. Save each community response against the exact concept revision with response id, time, consent/privacy choice, source, structured priorities, rating, comment, and moderation/status fields. Keep raw responses immutable. Summarize themes and conflicts separately, preserve minority views, and require human approval before selected feedback becomes versioned design constraints. Carry those approved constraints, with source response ids, into the next AI media or geometry generation run so the resulting revision has traceable inputs, outputs, costs, and decisions. Never publish private contact data or feed unmoderated responses directly into generation.\n\nUse Python when it is the faster deterministic path for geometry, analysis, QR generation, cost rollups, batch media, plots, or document export; use SVG/Three.js for interactive delivery and ComfyUI for generated media. Build complete responsive, accessible states. Critique with live screenshots or rendered output, repair overlap/clipping/weak hierarchy, and verify the QR destination, persisted feedback, budget math, and regeneration provenance. {media}"
    ))
}

pub(crate) fn is_design_context(message: &str) -> bool {
    message.starts_with(DESIGN_CONTEXT_PREFIX)
}

fn contains_term(value: &str, term: &str) -> bool {
    value.match_indices(term).any(|(start, _)| {
        let before = value[..start].chars().next_back();
        let end = start + term.len();
        let after = value[end..].chars().next();
        before.is_none_or(|character| !character.is_ascii_alphanumeric())
            && after.is_none_or(|character| !character.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests {
    use super::{context_for_request, is_design_context};

    #[test]
    fn activates_for_design_work_and_exposes_comfy_guardrails() {
        let context = context_for_request("Present this architectural concept better", true)
            .expect("design context");
        assert!(is_design_context(&context));
        assert!(context.contains("site, structure, enclosure, climate"));
        assert!(context.contains("Use Python when it is the faster deterministic path"));
        assert!(context.contains("call server_info first"));
        assert!(context.contains("Ask before downloads, installs, paid nodes"));
        assert!(context.contains("QR code that resolves to its accessible review page"));
        assert!(context.contains("total project budget"));
        assert!(context.contains("design/media/geometry creation cost"));
        assert!(context.contains("Keep raw responses immutable"));
        assert!(context.contains("require human approval"));
        assert!(context.contains("source response ids"));
        assert!(context.contains("verify the QR destination"));
    }

    #[test]
    fn stays_out_of_unrelated_work() {
        assert!(context_for_request("Fix the failing Rust unit test", true).is_none());
        assert!(context_for_request("Review the software architecture", false).is_some());
    }
}
