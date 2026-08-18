# Simple Cursor Chat

**Date:** 2026-08-18
**Status:** Current native interaction scope

## The whole product surface for now

```text
tap Command + Shift
        ↓
translucent text field beside the pointer
        ↓
type and press Return
        ↓
stream the answer directly underneath
```

No canvas, launcher results, persistent mode picker, context chips, settings,
run stream, or receipt chrome appears in the primary surface. The screenshot
reference contributes only its useful interaction qualities: one large frosted
input, high contrast, generous radius, immediate focus, and an output region
that exists only when there is output.

Plain input is read-only local chat. It uses HII's default local model and
skips the workspace agent loop entirely to reduce time to first useful output.
The earlier governed implementation is integrated through explicit `/do`,
`/plan`, `/browse`, `/see`, and `/show` commands in the same composer. Only
write-capable commands reveal an inline Allow/Cancel boundary. Existing CLI
receipts remain underneath the surface without becoming persistent chrome.

Command + Shift is a modifier-only gesture and therefore requires Accessibility
permission. Any non-modifier key press cancels the gesture, preserving normal
shortcuts such as Command + Shift + 4. Control + Option + H is the fallback.

## Proof boundary

Static tests and a packaged build can prove the gesture state machine, window
construction, process invocation, and bundle closure. Only a live installed-app
test can prove pointer placement, translucency, focus, shortcut delivery, and
first-token feel. Do not call those qualities shipped until that test runs.

## Feature order after the chat loop feels right

Add exactly one feature per verified iteration. Candidate sequence: current-app
name, selected text, hold-to-talk, read-only tools, consequential actions, then
receipts. The founder chooses each addition; none is implied by this record.
