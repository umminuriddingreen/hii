# Continuous output for the persistent HII agent

HII's CLI now appends model response bytes, tool calls, and tool results to one
continuous session transcript. Historical output-view settings remain accepted,
but cannot restore the synthetic Thinking/Preparing activity display. Private
reasoning stays outside the visible stream; reasoning budgets and loop detection
remain active. Removed obsolete inference-row rendering and replacement helpers.

Explicit `HII_UI_LINE_MODE` also enters the persistent conversation with piped
input/output, allowing a page bridge to use the same agent without terminal
widgets. Bare piped HII without that opt-in retains its existing home output.
Session history, steering, queueing, cancellation, authority, receipts, and
context checkpoint logic retain their existing ownership.

Validation: 583 CLI tests passed, one ignored; the unchanged
`route::tests::the_core_surface_stays_small` fails because the core command list
has 23 entries. Agent-home and launcher smoke checks passed. A loopback mock
provider exercised split model deltas, a real workspace read, two user turns,
and manual context checking: each reply appeared once, tool text was visible,
reasoning and synthetic Thinking rows were absent, and earlier user context
reached the next request. This small fixture did not trigger compaction; existing
checkpoint/restart tests passed. No fresh real-model, Windows, or visual proof is
claimed. ChatGPT inspection was blocked by the computer-use tool.

The next surface direction is a continuous shared page backed by HII's existing
object store, with canvas and other views over the same information. AFFiNE and
BlockSuite are reference checkouts, not integrated dependencies in this patch.
Folder sources preserve originals and manual layouts; output frames produce
verified artifacts. Geographic/photo-to-PDF work remains proposed.
