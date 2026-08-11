# Visual Precedent Mining Skill Draft

Use this workflow when HII needs to mine visual precedent from Pinterest, Cosmos, design blogs, listing photos, city design guidelines, or logged-in inspiration libraries to generate concept slides, boards, design options, or architecture project briefs.

## Authority Model

Default to public and official sources. Logged-in sites are allowed only when the operator has opened the browser session and explicitly asks HII to inspect that visible page, board, collection, or search result.

Never export private boards, private collections, DMs, account settings, cookies, tokens, or hidden profile data. Capture only visible items needed for the project and record source URL, title, creator/source when visible, and timestamp.

## Source Lanes

### Official API Lane

Use this first when credentials and terms allow it.

- Pinterest: use official Pinterest developer/API surfaces for authorized boards, Pins, content management, catalog, ads, and approved search endpoints.
- Cosmos: use a first-party API only if Cosmos publishes and authorizes one for the operator account.
- Other platforms: prefer official APIs, export tools, RSS, site maps, or user-provided downloads.

### Logged-In Browser Lane

Use this only with explicit operator approval.

1. Ask the operator to open the target site and navigate to the intended board, collection, or search.
2. Inspect only the visible page/screen.
3. Capture bounded metadata: title, thumbnail/screenshot reference, visible caption, source link, tags, and why it matters.
4. Do not automate follows, saves, likes, comments, purchases, uploads, messages, or profile changes.
5. Stop after the approved scope: e.g. "top 30 visible pins for Eichler atrium landscape."

### Public Web Lane

Use HII discovery/search for official pages, public images, listing pages, city documents, blogs, manufacturer pages, and design references. Prefer sources with stable URLs and clear attribution.

## Mining Query Pattern

For architecture concepts, gather references in six buckets:

- Form: roofline, massing, street silhouette, addition strategy
- Threshold: entry, atrium, indoor/outdoor transitions
- Material: posts, beams, decking, fascia, slab, tile, glass, planting
- Program: ADU, studio, co-living, workroom, leaseable suite
- Climate: shade, ventilation, electrification, water, fire/heat resilience
- Community: signage, feedback, pre-lease, local contractor/investor signal

## Output Contract

Every mining run should produce:

- Source table with URL/account/board/collection, capture date, and access type
- 12-30 selected precedents grouped into 3-5 themes
- One mood board or concept board
- One slide outline
- Design moves tied back to site constraints
- Risk notes: copyright, privacy, code uncertainty, and market uncertainty

## Concept Generation Loop

1. Start with site facts and constraints.
2. Mine precedents by bucket.
3. Cluster by pattern, not by aesthetics alone.
4. Translate each cluster into design moves.
5. Make 2-3 options with budget and entitlement implications.
6. Produce a board and slides.
7. Record a HII receipt with sources, assumptions, and verification.

## Current Channing Court Use

For the 1601 Channing Ave concept, use Pinterest/Cosmos for:

- Eichler atrium restorations
- Palo Alto / Bay Area rear pavilion additions
- Flat-roof ADU garden studios
- Mid-century privacy fencing and native planting
- QR-backed community development campaign precedents

Do not scrape logged-in feeds silently. Use operator-visible capture or official APIs.
