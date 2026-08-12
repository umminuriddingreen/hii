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
        "{DESIGN_CONTEXT_PREFIX}\nDesign is native HII work. Inspect the real subject, audience, content, constraints, precedents, and existing visual system. Make the primary object and one job obvious; use hierarchy, typography, spacing, line, tone, color, and motion to encode meaning. For architecture, pair concept with site, structure, enclosure, climate, light, comfort, material, construction, and human use; label diagrams, calculations, simulations, and measurements honestly. Use Python when it is the faster deterministic path for geometry, analysis, batch media, plots, or document export; use SVG/Three.js for interactive delivery and ComfyUI for generated media. Build complete responsive, accessible states. Critique with live screenshots or rendered output, repair overlap/clipping/weak hierarchy, and verify the actual workflow. {media}"
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
    }

    #[test]
    fn stays_out_of_unrelated_work() {
        assert!(context_for_request("Fix the failing Rust unit test", true).is_none());
        assert!(context_for_request("Review the software architecture", false).is_some());
    }
}
