# HII minimal interface studies

Generated locally with ComfyUI and the installed Z-Image-Turbo workflow.

Core product idea: HII is information and space. People place information directly in a quiet spatial surface. Local models react to selected material, leave useful traces beside it, and can be steered through placement, grouping, and marks. The model is present through its work, not through a permanent chat panel.

Shared constraints:

- one nearly full-bleed warm-white surface;
- pencil-and-paper simplicity;
- no dashboard, sidebar, toolbar, floating card grid, or separate chat window;
- no glossy gradients, glassmorphism, skeuomorphic device frame, or dense navigation;
- only a few information objects at human reading scale;
- model attention is shown subtly beside selected information;
- monochrome graphite and warm paper, with at most one quiet cobalt accent;
- desktop landscape product concept, 1344 by 768.

## Iterations

### 01 - Sheet

Seed: `928401`

The canvas behaves like a single sheet of paper. A short note, a cropped photograph, and a tiny schedule sit directly on the surface with no containers. One phrase is underlined by hand. A faint model response grows from the underline in the margin as two concise useful annotations. Almost everything else is empty space.

### 02 - Field

Seed: `928402`

The canvas is an open information field. Three sparse pieces of material are placed far apart: a paragraph, an image fragment, and a date. A thin graphite loop groups two of them. The model's attention appears only as a pale local halo and a small proposed artifact near the group. No global controls are visible.

### 03 - Trace

Seed: `928403`

The canvas shows a person's rough working marks and the model's useful traces together. Human marks are darker graphite; model additions are lighter graphite with one tiny blue proof dot. A source excerpt becomes a compact plan and a finished small artifact in place. The transformation is spatial, not conversational.

### 04 - Quiet command

Seed: `928404`

The canvas is almost blank. A single insertion point and a few placed objects are visible. Typing directly on empty space creates information; drawing a loose boundary steers the model. Near the active mark, one understated line offers the next useful action. There is no persistent command bar.

### 05 - Synthesis

Seed: `928405`

An image-guided refinement of `01-sheet.png` at `0.38` denoise. It preserves the empty sheet and direct-on-surface material while testing a lighter model trace. This is the strongest visual base; combine it with the explicit human-mark-to-model-trace relationship in `03-trace.png`.

### 06 - Typed composite

Seed: `928406`

Preferred production method and current final study. ComfyUI generated `06-typed-composite-base.png` with no text, letters, numerals, logos, labels, or interface chrome. `06-typed-composite.html` then placed exact editable Inter typography over that base, and Chrome rendered the final `06-typed-composite.png`.

This division of labor is intentional:

- the local visual model creates material, atmosphere, marks, and spatial composition;
- the native interface renderer creates every word, number, icon, control, and proof label;
- generated text is never shipped as interface text;
- copy can be changed without rerunning the image model.

## Review

- `01-sheet.png`: keep. The interface nearly disappears and the surface reads as a working sheet.
- `02-field.png`: reject. The generator reintroduced a framed app and mini-cards.
- `03-trace.png`: keep as an interaction diagram. It clearly distinguishes source, human steering, and model response.
- `04-quiet-command.png`: reject. It reintroduced profile imagery and permanent application chrome.
- `05-synthesis.png`: preferred visual base. It is the quietest and most materially coherent.
- `06-typed-composite.png`: preferred final. It retains the local-model material quality while making all language exact and editable.

Generated text is intentionally not product copy and is not suitable for implementation. These are composition and interaction studies; production typography should be rendered natively.

## Product rule extracted from the studies

The default HII surface contains information, not interface. A person types, drops, groups, circles, or connects material directly in space. Those spatial acts are the prompt. A model response appears locally as a light trace beside the affected material. Accepting a trace turns it into a normal information object; ignoring it lets it disappear. Navigation, command entry, provenance, and model controls appear only on invocation. A single proof mark can indicate completed verified work; detail stays behind that mark until requested.

## Local generation provenance

- ComfyUI `0.22.0` at `http://127.0.0.1:8188`
- GPU: NVIDIA GeForce RTX 5080
- diffusion model: `z_image_turbo_bf16.safetensors`
- text encoder: `qwen_3_4b.safetensors`
- VAE: `ae.safetensors`
- sampler: `res_multistep`, 8 steps, CFG 1
- output size: 1344 by 768
- prompt IDs: `6fbaf27d-d419-42b5-a9ed-864743dc6107`, `1bc6c063-9930-4b75-9344-1169de9f85f9`, `021c27fe-e240-4418-8214-64d86f1898a9`, `d4e8d179-52df-41f2-b158-1969d4b84313`, `c2292173-7027-4ff0-876a-da2476ad653a`
- typed-composite base prompt ID: `56cc78f6-ffff-4923-a5d2-39c802cb4d24`
