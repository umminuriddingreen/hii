# Notch, Browser, and Create

HII has three focused modes over one local project, object model, execution boundary, and proof history.

## Notch

Notch is the persistent macOS edge of HII. It shows meaningful active state, accepts a new intent, and opens Browser, Create, or the spatial Workspace. It reads `~/.hii/ecosystem/events.jsonl`; it does not maintain another task database or agent runtime.

The native `Command-Shift-Space` shortcut expands Notch. Losing focus or submitting work collapses it without discarding system state. Work still executes through the existing `hii run` path and its proof log.

## Browser

Browser is the information-retrieval mode. A local temporary Chromium session can navigate and render HTTP(S) pages. Page text or a user selection becomes a `hii.capture` record containing its project, URL, source, local-only permission, and SHA-256 content hash.

Capturing material does not authorize delivery to a model. Context review and external transmission remain separate governed actions. Captures can be handed directly into Create without copying or re-explaining the source.

## Create

Create is the visual workflow mode. Its graph joins source context, creative direction, a bounded capability, human approval, and a verified output. Every save creates an append-only `hii.workflow` revision with the exact ComfyUI API prompt and a revision hash.

Create queues a local ComfyUI prompt only after the operator checks that the displayed revision was reviewed. It polls the returned prompt history, records running and completed events, and preserves ComfyUI output references as proof. ComfyUI remains a managed local capability rather than HII's canonical store.

## Shared runtime contract

The local API is `/api/ecosystem` and the canonical runtime directory is `~/.hii/ecosystem/`:

- `captures.jsonl`: source-linked Browser captures.
- `workflows.jsonl`: append-only Create workflow revisions.
- `events.jsonl`: state projected into Notch and other HII views.

The user-facing mode names are exactly **Notch**, **Browser**, and **Create**. Workspace remains the spatial review and composition surface shared by all three.

## Upstream boundary

ComfyUI, Boring Notch, and Helium remain separate reference or capability repositories. Their GPL-3.0 code is not copied into HII. A future acquisition or redistribution must resolve contributor rights and license obligations before changing that boundary.
