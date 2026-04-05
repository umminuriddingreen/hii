# HII Content Platform Plan

This document defines the implementation plan for evolving HII from a local reasoning/chat CLI into a local-first content pipeline and publishing system.

It is written against the current HII codebase:

- Chat entrypoint: `src/cli.ts`
- Chat orchestration: `src/orchestrator.ts`
- Model backends: `src/clients/chat.ts`, `src/clients/ollama.ts`, `src/clients/lmstudio.ts`
- HTTP surface: `src/server.ts`
- Current local memory and content graph: `src/memory.ts`, `src/store/native_memory.ts`, `src/graph.ts`
- Existing lightweight UI/static assets: `public/`, `engine/serve/server.py`

## Product Direction

HII should become a local-first content OS with these core layers:

1. `hii chat` as the local intelligence layer
2. A content pipeline that turns local files into structured publishable assets
3. A UI/feed layer for browsing content
4. A secure local-to-remote exposure layer over Tailscale
5. A user/content/product model that can grow into payments and CDN-backed distribution

The first milestone is not a social app. The first milestone is a strong local system that works well on normal user machines with local models.

## Core Product Thesis

HII should aim to become a human-focused network for communication, content, and commerce.

The long-term ambition is not just "better chat" or "better publishing."
The ambition is to provide a user-controlled alternative to systems like Discord, but built around:

- direct human connection
- user-owned media and identity
- privacy by default
- minimal or no surveillance-style data collection
- local-first and user-net-first architecture
- commerce that serves creators and communities rather than extracting from them

HII should be understood as:

- human information interface
- communication network
- content network
- commerce network

It should feel closer to a human operating layer than a typical social product.

## Two-Network Model

HII should not be designed as a normal CDN-first social platform.

It should operate across two distinct networks:

1. `Public Directory Network`
2. `Private User Net`

### Public Directory Network

This is the discovery and browse layer.

Its purpose:

- public profiles
- public content listings
- public previews
- global search and feed surfaces
- optional public product pages

This layer should not be assumed to hold the user's canonical originals.

The public directory is where HII helps people find content.
It is not the only place where content lives.

This network should eventually support:

- public user pages
- public channels/spaces
- discoverable topics and media
- public product listings
- lightweight public messaging entrypoints

### Private User Net

This is the user-controlled sharing layer.

Its purpose:

- private media sharing across trusted user networks
- work-in-progress sharing
- full-resolution originals
- restricted collaboration
- private product/test pages
- internal drafts and unpublished assets

This layer should be private-by-default and built around direct user control.

This network should eventually support:

- direct messages
- private groups
- private rooms/spaces
- private commerce
- private customer communities
- trusted collaborative workspaces

### Strategic difference

This makes HII meaningfully different from platforms where the platform owns the full hosting and delivery layer.

HII should instead act as:

- content index
- metadata and preview generator
- identity and visibility layer
- private/public router
- optional caching and replication layer

The user should decide what remains:

- local only
- shared privately
- published globally

## Communication and Commerce Layer

HII should eventually functionally replace a large subset of what people use Discord for, but with a different architecture and product ethic.

The target is not "copy Discord UI."
The target is to replace the useful primitives:

- identity
- messaging
- group spaces
- media sharing
- presence
- community access
- lightweight commerce
- creator/customer relationships

### Communication primitives

HII should eventually support:

- direct messaging
- small-group messaging
- channels/rooms
- voice and video later, but not first
- rich media sharing
- thread-like or topic-based replies
- message-linked content items
- public and private spaces

Every communication object should be able to reference:

- content items
- folders
- products
- events
- users

### Commerce primitives

HII should eventually support:

- product pages
- paid community access
- paid private drops
- direct creator-to-user sales
- gated content
- lightweight storefronts
- order and fulfillment metadata

This should all sit on top of the same user/content graph, not in a separate system.

### Commerce analogy

The cleanest framing is:

`imagine if Shopify were free, self-hosted, and every store could optionally appear in a shared global directory.`

That is closer to the HII commerce goal than a normal marketplace model.

In HII:

- each user can operate a self-hosted storefront
- products can live alongside content and community
- the public directory can index stores, products, and creators
- private storefronts and invite-only commerce should also be possible
- the platform should connect stores rather than own every store

This means HII commerce should support both:

- `self-hosted first`
- `directory-connected second`

The directory should behave like a global mall, not the canonical owner of every store.

### Why HII is different

Discord is optimized around platform-owned communication surfaces.
HII should be optimized around user-owned communication surfaces.

That means:

- messages can point to user-owned content and assets
- communities can exist across user nets
- private groups do not require the platform to own every original file
- public discovery and private exchange are separate layers
- commerce is integrated into human connection rather than bolted on as ads or platform extraction

## Privacy and Data Collection Principles

HII should be explicit about what it is not.

It should not be built around:

- behavioral surveillance
- ad targeting
- excessive analytics
- opaque recommendation systems
- platform capture of user relationships

Baseline principles:

- no unnecessary data collection
- user-visible data flows
- local-first storage where practical
- private-net by default
- explicit publish actions
- clear provenance of where content is stored
- clear distinction between metadata, previews, and originals

Recommended default posture:

- collect only operational telemetry needed to run the system
- keep personal graph and content graph user-controlled
- make export and self-hosted operation possible from the start
- avoid making the global directory the mandatory home of user identity

## Community and Space Model

To support communication and commerce, HII should eventually introduce the concept of spaces.

Suggested first-pass space types:

- `dm`
- `group`
- `channel`
- `community`
- `storefront`
- `project-space`

Each space should have:

- owner
- members
- visibility
- linked content items
- linked products
- feed surface
- messaging surface

This lets HII unify:

- chat
- media sharing
- creator pages
- product pages
- communities

inside one network model.

## Research and Precedents

These are the strongest external precedents for the HII roadmap. They are included to anchor implementation decisions in products and docs that already work.

### Local-first AI and chat runtime

- LM Studio
  - Relevance: strong precedent for running local models on consumer hardware, offering a familiar chat UI, and exposing a local OpenAI-compatible API. This directly supports the `hii chat` efficiency work and local-runtime product direction.
  - Product: <https://lmstudio.ai/>
  - Docs: <https://lmstudio.ai/docs/>
  - Local API: <https://lmstudio.ai/docs/developer/core>

- Jan
  - Relevance: strong precedent for a user-owned local AI desktop, model management, and MCP-based extensibility. Useful for HII's local-first chat, model hub ideas, and future connector/tool surface.
  - Docs overview: <https://docs.jan.ai/>
  - Desktop overview: <https://www.jan.ai/docs/desktop>
  - Model management: <https://www.jan.ai/docs/models/manage-models>
  - API: <https://docs.jan.ai/api/>

- Ollama
  - Relevance: strong precedent for simple local model serving and API-backed local AI application architecture. Useful for keeping HII lightweight on user systems.
  - Docs: <https://ollama.com/>
  - API/docs entry: <https://github.com/ollama/ollama/tree/main/docs>

### Local media library, sharing, and user-owned content

- Immich
  - Relevance: strong precedent for self-hosted photo/video management with private sharing, shared albums, and public links. Useful for HII's local-folder content model, user pages, and private/public sharing controls.
  - Product: <https://immich.app/>
  - Sharing docs: <https://immich.app/docs/features/sharing/>

- PhotoPrism
  - Relevance: strong precedent for local/self-hosted media organization, albums, folders, and secret share links with expiry. Useful for HII's folder-backed content browser and sharing mechanics.
  - Docs home: <https://www.photoprism.app/kb/docs>
  - Album sharing docs: <https://docs.photoprism.app/user-guide/share/>
  - Guest sharing docs: <https://docs.photoprism.app/user-guide/users/sharing/>

- PeerTube
  - Relevance: strong precedent for user-owned video publishing and creator pages on self-hosted infrastructure. Useful for HII's video-first feed, user pages, and long-term creator/content model.
  - Docs: <https://docs.joinpeertube.org/>

- Are.na
  - Relevance: strong precedent for treating links, files, text, and media as first-class content objects inside channels. Useful for HII's "file paths and links become content blocks with metadata" model and grid-native browsing.
  - Blocks docs: <https://help.are.na/docs/getting-started/blocks>
  - Adding blocks: <https://help.are.na/docs/getting-started/blocks/adding-blocks>
  - Channels: <https://help.are.na/docs/getting-started/channels>

### Private exposure and local publishing

- Tailscale Serve
  - Relevance: best precedent for private-by-default exposure of a local service to a trusted network, with identity headers and local-backend proxying. This is the clearest model for HII private publishing.
  - Docs: <https://tailscale.com/docs/features/tailscale-serve>

- Tailscale Funnel
  - Relevance: best precedent for optional public exposure of a local service without requiring the user to stand up full public infra first. Useful for HII's path from tailnet-only to public publishing.
  - Docs: <https://tailscale.com/docs/features/tailscale-funnel>
  - CLI docs: <https://tailscale.com/docs/reference/tailscale-cli/funnel>

- untitled.stream
  - Relevance: useful product precedent for creator-owned sharing surfaces, especially around work-in-progress media, share links, access control, and a productized creator UX. HII should take the creator-surface lesson but keep media control closer to the user by splitting public discovery from private sharing.
  - App listing: <https://apps.apple.com/us/app/untitled-for-desktop/id6744922982>

### CDN and asset pipeline

- Cloudflare Images
  - Relevance: strong precedent for image storage, variants, optimization, and signed access. Useful when HII grows from local image serving into optional CDN-backed image delivery.
  - Docs: <https://developers.cloudflare.com/images/>

- Cloudflare Stream
  - Relevance: strong precedent for a unified video pipeline: upload, encode, deliver, secure, and analyze. Useful for HII's future video delivery layer after local-first publishing is stable.
  - Docs: <https://developers.cloudflare.com/stream/>

- Cloudflare R2
  - Relevance: strong precedent for object storage as the replication/output layer behind a local-origin system. Useful for optional HII content replication and public asset serving.
  - Docs: <https://developers.cloudflare.com/r2/>
  - Architecture: <https://developers.cloudflare.com/r2/how-r2-works/>

### Products and payments

- Stripe Checkout
  - Relevance: best precedent for getting HII products monetizable quickly without overbuilding a bespoke payments stack. Useful for `product` pages and hosted checkout in the first commerce phase.
  - Docs: <https://docs.stripe.com/payments/checkout>
  - How it works: <https://docs.stripe.com/payments/checkout/how-checkout-works>

- Stripe Product Catalog
  - Relevance: useful precedent for treating products as first-class records rather than ad hoc payment links. Useful once HII has product entities attached to content.
  - Docs: <https://docs.stripe.com/payments/checkout/product-catalog>

- Stripe Payment Links
  - Relevance: useful for the absolute fastest path to paid products before HII has a deeper commerce backend.
  - Product: <https://stripe.com/payments/payment-links>

### Generative demoscene, sketching, and 3D

- ComfyUI
  - Relevance: best precedent for node-based local generative workflows that users can inspect, remix, and automate. This maps directly to HII's content pipeline and generative demoscene ambitions.
  - Docs: <https://docs.comfy.org/>

- Excalidraw
  - Relevance: strong precedent for real-time sketch surfaces and embeddable canvas tooling. Useful for HII's real-time sketching phase.
  - Developer docs: <https://docs.excalidraw.com/>

- Spline AI 3D Generation
  - Relevance: strong precedent for text/image-to-3D as a creator-facing UX, especially for making 3D generation legible to non-technical users. Useful for HII's later 3D export and scene workflows.
  - Docs: <https://docs.spline.design/spline-ai/ai-3d-generation>
  - Product: <https://spline.design/ai>

- Draw Things
  - Relevance: strong precedent for making local Stable Diffusion workflows usable on normal user hardware with a productized UI. Useful for HII's "local models first" creative tooling and image-generation UX.
  - Product: <https://drawthings.ai/>
  - Stable Diffusion overview: <https://wiki.drawthings.ai/wiki/About_AI_and_Stable_Diffusion>

- TripoSR
  - Relevance: strong precedent for fast image-to-3D reconstruction and a practical bridge from 2D media to exportable 3D assets. Useful for HII's future 3D export pipeline.
  - Repository: <https://github.com/VAST-AI-Research/TripoSR>

- Hunyuan3D-2.1
  - Relevance: strong precedent for richer 3D asset generation, including textured outputs and a more production-oriented 3D workflow than simple mesh reconstruction alone.
  - Repository: <https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1>

## MVP Definition

Build this first:

1. Make `hii chat` efficient with local models on user systems
2. Let users select a folder on their machine as HII content
3. Expose that folder through HII over a Tailscale-friendly local backend
4. Build a UI that renders content from that folder
5. Support four initial content types:
   - images
   - videos
   - HTML pages
   - simple product records

The MVP should treat local files as the source of truth.

## Content Model

The content system should normalize local files into a small internal schema.

Suggested first-pass types:

- `image`
  - source file path
  - title
  - caption
  - tags
  - createdAt
  - dimensions
- `video`
  - source file path
  - title
  - caption
  - tags
  - createdAt
  - duration
  - poster image
- `page`
  - source file path
  - title
  - summary
  - tags
  - createdAt
  - html body or rendered output path
- `product`
  - source file path or JSON record
  - title
  - description
  - price
  - media refs
  - status

Each item should also carry:

- stable local id
- owner/user id
- visibility
- checksum
- derived assets
- feed rank metadata

## File and Link System

Links in HII content should resolve to local file-backed items first.

Initial rule:

- a "link" is a file path shared with HII
- HII indexes it
- HII derives metadata and previews
- HII renders it in UI
- HII can expose it through a local server

Recommended storage shape:

- source content remains in user-owned folders
- HII stores indexes and derived metadata under `~/.hii/`
- derived previews live under `~/.hii/content-cache/`

Suggested runtime files:

- `~/.hii/content/index.json`
- `~/.hii/content/items/<id>.json`
- `~/.hii/content/derived/...`

## Visibility States

Every content item should have an explicit visibility state.

Required states:

- `local-only`
- `private-net`
- `public-directory`

### `local-only`

The item exists only on the user's machine or local storage.

Use for:

- drafts
- experiments
- generated artifacts not ready to share
- local notes/pages/products under construction

### `private-net`

The item is available to explicitly allowed users or devices across the private HII network.

Use for:

- WIP sharing
- private collaboration
- client review
- paid/private previews
- team-only media

### `public-directory`

The item is discoverable in the public HII directory.

Use for:

- public user pages
- public posts/videos/images/pages
- product listings
- previews intended for wide discovery

Public-directory items may still keep originals outside the public edge layer.
The public layer does not need to own the canonical asset.

## UI Direction

The UI should not start as a generic dashboard.

The initial content surfaces should be:

1. `hii chat` UI improvements
2. an IG reels-style vertical feed
3. a grid view
4. a per-user page
5. a per-item detail page

### Feed Views

Reels view:

- vertical swipe or keyboard next/prev
- autoplay video
- image fullscreen mode
- product CTA panel
- provenance panel showing source file

Grid view:

- dense media browser
- mixed content cards
- filtering by type, user, folder, tags

User page:

- avatar and handle
- content tabs: videos, images, pages, products
- local-first profile data

## `hii chat` Improvements

This is the first engineering priority.

Current state:

- `src/orchestrator.ts` has a compact hardcoded tool loop
- `src/clients/chat.ts` routes to `codex`, `mlx`, `ollama`, `claude`
- interactive chat lives inside `runInteractiveChat()` in `src/cli.ts`

Required improvements:

1. Reduce latency for local models
2. Improve tool-call reliability
3. Keep long sessions usable
4. Make chat aware of content items and local file assets

### Local-model efficiency plan

Phase 1:

- default to smaller, faster local models for interactive turns
- support explicit "fast" and "quality" chat profiles
- separate planning model from content-generation model
- cache system prompt and memory context assembly
- trim repeated history inflation in `src/orchestrator.ts`

Phase 2:

- add token budgeting and auto-compaction
- add structured tool registry instead of only switch-based tool dispatch
- add streaming response support for local backends where possible
- add cheap retrieval-first routing before model invocation

Phase 3:

- add background workers for ingestion, preview generation, embeddings, and media analysis

### Recommended first technical changes

1. Add `ChatProfile` to `src/config.ts`
   - `fast-local`
   - `balanced-local`
   - `quality-local`
2. Refactor `src/clients/chat.ts`
   - normalize backend capabilities
   - support streaming where possible
   - track per-backend latency and fallback
3. Refactor `src/orchestrator.ts`
   - move tools into a registry
   - support typed tool specs
   - support context compaction
4. Add `content_search` and `content_open` tools
5. Add `feed_generate` tool for ranking and feed assembly

## Feed System

The feed system should spawn content from user content and link metadata.

The feed is not just chronological. It should support:

- chronological feed
- folder feed
- per-user feed
- featured feed
- related-content feed

Initial feed generation can be deterministic:

- sort by created time
- group by type
- boost content with derived thumbnails and captions

Later, HII can use local-model scoring for:

- caption generation
- topic clustering
- similarity-based recommendations
- "turn this folder into a feed" workflows

### Feed behavior across networks

Public feed:

- built from `public-directory` items only
- optimized for discovery and public browsing
- can rely on cached derivatives

Private feed:

- built from `private-net` items visible to the current user
- optimized for collaboration, review, and private sharing
- should preserve provenance and access context

Local feed:

- built from `local-only` plus everything visible to the owner
- optimized for creation workflow and self-management

Communication feeds should also exist:

- inbox feed
- community feed
- storefront feed
- private room feed

This allows HII to bridge content, chat, and commerce without turning everything into one generic timeline.

## Local Exposure Over Tailscale

This should be built as HII-owned local infrastructure, inspired by `tailscaled` style thinking, but not by copying it.

Target:

- expose HII content and UI securely from the user machine
- support private-by-default access
- resolve user page and content page URLs over Tailscale

Suggested MVP:

1. HII local server serves UI and content metadata
2. HII generates stable local routes:
   - `/u/:user`
   - `/content/:id`
   - `/media/:id`
3. User exposes server via Tailscale Funnel or serve
4. Access control remains local and simple

### Origin / relay / edge model

HII should use three serving layers:

1. `Origin`
2. `Private relay`
3. `Public edge`

#### Origin

The canonical source of truth.

Examples:

- local folder on the user machine
- external drive
- user-owned storage node

#### Private relay

The private routing and access layer across trusted user nets.

Examples:

- Tailscale-backed private exposure
- HII private network gateway
- signed private links between users

#### Public edge

The optional public acceleration layer.

Examples:

- cached previews
- transcoded public video variants
- public thumbnails
- globally accessible static copies of explicitly public assets

HII should only push assets into the public edge when the user explicitly publishes them.

Suggested HII commands:

- `hii publish folder --path <path>`
- `hii publish status`
- `hii publish tailscale enable`
- `hii publish url`

Suggested future network commands:

- `hii net create-space --type <type> --name <name>`
- `hii net invite --space <id> --user <id>`
- `hii net share --content <id> --to <space|user>`
- `hii net message --space <id> --text "..."`
- `hii net publish --content <id> --visibility <state>`

Longer term:

- HII-managed reverse proxy layer
- signed URLs
- device-level auth
- remote asset fetch policies

### Routing model

Suggested route families:

- `/u/:user`
  - user page
- `/content/:id`
  - content detail page
- `/media/:id`
  - asset resolver
- `/private/:token/:id`
  - private share route
- `/products/:id`
  - product detail page

The resolver should choose the correct serving path:

- direct local origin if owner is viewing locally
- private relay if content is `private-net`
- public edge or public origin if content is `public-directory`

### Permission model

Every content request should check:

- viewer identity
- content visibility
- origin availability
- whether a derived preview is allowed
- whether the original asset is allowed

HII should support preview-only publication for some content:

- public preview
- private full-res original

That is especially useful for:

- works in progress
- client review
- paid products
- large video/image originals

## Full Platform Spec

HII should be treated as a unified platform with five core domains:

1. identity
2. communication
3. content
4. commerce
5. networking

All product surfaces should be built on a shared graph of users, spaces, messages, content items, products, and permissions.

## Primary Entities

### User

Represents a human participant in the HII network.

Required fields:

- `id`
- `handle`
- `displayName`
- `bio`
- `avatarRef`
- `publicKeys`
- `homeNodeId`
- `profileVisibility`
- `createdAt`
- `updatedAt`

Optional fields:

- links
- contact methods
- storefront settings
- membership settings
- payment destination metadata

### Node

Represents a user-controlled machine or service running HII.

Required fields:

- `id`
- `ownerUserId`
- `name`
- `networkType`
- `publicCapability`
- `privateCapability`
- `status`
- `lastSeenAt`

Examples:

- laptop
- desktop
- home server
- VPS relay

### Space

Represents a communication or community container.

Required fields:

- `id`
- `type`
- `ownerUserId`
- `name`
- `description`
- `visibility`
- `memberPolicy`
- `contentPolicy`
- `createdAt`
- `updatedAt`

Allowed initial types:

- `dm`
- `group`
- `channel`
- `community`
- `storefront`
- `project-space`

### Membership

Represents a user's role in a space.

Required fields:

- `id`
- `spaceId`
- `userId`
- `role`
- `status`
- `joinedAt`

Roles:

- `owner`
- `admin`
- `moderator`
- `member`
- `viewer`

### Message

Represents communication inside a space or direct thread.

Required fields:

- `id`
- `spaceId`
- `senderUserId`
- `body`
- `messageType`
- `visibility`
- `createdAt`
- `updatedAt`

Optional fields:

- `replyToMessageId`
- `attachments`
- `linkedContentIds`
- `linkedProductIds`
- `linkedOrderIds`
- `threadId`

Initial message types:

- `text`
- `media`
- `content-share`
- `product-share`
- `system`

### ContentItem

Represents any user-owned publishable or shareable content object.

Required fields:

- `id`
- `ownerUserId`
- `originNodeId`
- `type`
- `sourcePath`
- `title`
- `summary`
- `visibility`
- `status`
- `mimeType`
- `createdAt`
- `updatedAt`

Optional fields:

- tags
- dimensions
- duration
- posterRef
- previewRefs
- metadata
- linkedSpaceIds
- linkedProductIds

Allowed initial types:

- `image`
- `video`
- `page`
- `product-media`
- `document`
- `audio`

Future types:

- `scene`
- `model`
- `sketch`
- `workflow`

### ShareGrant

Represents who can access a private item or route.

Required fields:

- `id`
- `resourceType`
- `resourceId`
- `grantType`
- `subjectId`
- `permissions`
- `createdAt`
- `expiresAt`

Grant types:

- `user`
- `space`
- `token`
- `network`

### Product

Represents something sellable in HII.

Required fields:

- `id`
- `ownerUserId`
- `title`
- `description`
- `status`
- `pricingModel`
- `visibility`
- `createdAt`
- `updatedAt`

Optional fields:

- media refs
- attached content ids
- inventory metadata
- payment provider metadata
- fulfillment metadata

Pricing models:

- `free`
- `one-time`
- `subscription`
- `pay-what-you-want`
- `quote`

### Order

Represents a transaction or purchase record.

Required fields:

- `id`
- `buyerUserId`
- `sellerUserId`
- `productId`
- `status`
- `amount`
- `currency`
- `createdAt`
- `updatedAt`

Optional fields:

- delivery metadata
- entitlement metadata
- external payment id

### Entitlement

Represents what a user gets access to after an order or grant.

Required fields:

- `id`
- `userId`
- `resourceType`
- `resourceId`
- `accessType`
- `createdAt`
- `expiresAt`

## Product Surfaces

HII should support these major user-facing surfaces.

### Chat surface

Purpose:

- local reasoning
- retrieval
- orchestration
- content-aware assistance
- creation and publishing actions

Backed by:

- `src/clients/chat.ts`
- `src/orchestrator.ts`
- future `src/chat/`

### Feed surface

Purpose:

- browse content
- discover people and spaces
- navigate public and private media

View modes:

- reels
- grid
- list
- inbox
- space feed
- storefront feed

### User page

Purpose:

- identity
- public content
- public products
- links to spaces or communities

### Space page

Purpose:

- room/channel/community UI
- messaging
- shared content
- pinned products

### Product/storefront page

Purpose:

- creator commerce
- product listing
- paid access
- bundle and drop mechanics

## Network Architecture

HII should use a layered network design.

### Layer 1: Local runtime

Runs on user machines.

Responsibilities:

- model execution
- content indexing
- preview generation
- origin serving
- local chat
- local authorization decisions

### Layer 2: Private network

Connects trusted users and trusted nodes.

Responsibilities:

- private routing
- authenticated access
- private messaging
- collaboration
- private content exchange

Potential transport patterns:

- Tailscale
- direct user-net tunnels
- HII-managed relay later

### Layer 3: Public directory

Provides discovery and public routing.

Responsibilities:

- public profiles
- public content metadata
- public feeds
- public search
- public storefront discovery

### Layer 4: Public edge

Optional acceleration layer for public assets.

Responsibilities:

- caching
- transcoding
- global delivery
- static asset variants

## Identity and Addressing

Every HII resource should have:

- stable internal id
- human-readable route
- origin location
- current visibility state

Suggested addressing:

- user: `hii://user/<id>`
- space: `hii://space/<id>`
- content: `hii://content/<id>`
- product: `hii://product/<id>`
- order: `hii://order/<id>`

Human routes:

- `/u/:handle`
- `/s/:spaceSlug`
- `/c/:contentId`
- `/p/:productSlug`

## Messaging Spec

Messaging should be content-native, not separate from the content system.

Requirements:

- every message can link content
- every message can link products
- messages can be public or private depending on space
- threads should be lightweight
- attachments should resolve through the same content pipeline

Message capabilities by phase:

Phase 1:

- text
- image/video attachment
- reply
- basic thread

Phase 2:

- product share
- content card embed
- paid-content unlock messages
- moderation actions

Phase 3:

- calls/live rooms
- shared live canvas
- synchronized viewing modes

## Content Pipeline Spec

The pipeline should process local files into HII-native content items.

Stages:

1. discovery
2. fingerprinting
3. metadata extraction
4. preview generation
5. semantic indexing
6. feed classification
7. publish routing

### Discovery

Inputs:

- watched folders
- manual imports
- generated outputs from HII tools

### Fingerprinting

Generate:

- checksum
- source path
- origin node id
- mime type

### Metadata extraction

Generate:

- title guess
- timestamps
- dimensions or duration
- media-specific metadata

### Preview generation

Generate:

- thumbnails
- posters
- previews
- safe HTML snapshots when applicable

### Semantic indexing

Generate:

- embeddings
- tags
- local clusters
- related items

### Publish routing

Decide:

- local only
- private net
- public directory
- public edge derivatives

## API Spec

The HII platform should expose a stable API across local runtime and networked surfaces.

### Identity and users

- `GET /api/users/:id`
- `GET /api/users/:id/content`
- `GET /api/users/:id/products`
- `GET /api/users/:id/spaces`
- `PATCH /api/users/:id`

### Spaces and memberships

- `GET /api/spaces`
- `POST /api/spaces`
- `GET /api/spaces/:id`
- `PATCH /api/spaces/:id`
- `GET /api/spaces/:id/members`
- `POST /api/spaces/:id/invites`
- `POST /api/spaces/:id/join`

### Messages

- `GET /api/spaces/:id/messages`
- `POST /api/spaces/:id/messages`
- `PATCH /api/messages/:id`
- `POST /api/messages/:id/reply`

### Content

- `GET /api/content`
- `POST /api/content/import`
- `GET /api/content/:id`
- `PATCH /api/content/:id`
- `POST /api/content/:id/share`
- `POST /api/content/:id/publish`
- `GET /api/content/:id/access`

### Feed

- `GET /api/feed/public`
- `GET /api/feed/private`
- `GET /api/feed/local`
- `GET /api/feed/space/:id`
- `GET /api/feed/user/:id`

### Products and orders

- `GET /api/products`
- `POST /api/products`
- `GET /api/products/:id`
- `PATCH /api/products/:id`
- `POST /api/products/:id/buy`
- `GET /api/orders/:id`

### Publish and networking

- `POST /api/publish/folder`
- `GET /api/publish/status`
- `POST /api/network/relay/register`
- `GET /api/network/routes`
- `POST /api/network/share-token`

## Permissions and Trust

HII should use resource-level permissions, not only space-level permissions.

Checks should include:

- user role
- direct grants
- space grants
- purchased entitlements
- preview/original distinction
- visibility state
- node availability

Permission actions:

- view preview
- view original
- comment
- message into space
- reshare
- sell
- moderate
- administer

## Moderation and Safety

HII should remain privacy-first while still giving owners tools to control their spaces.

Initial controls:

- block user
- remove member
- remove message
- unpublish content
- revoke share token
- disable public page

Community controls later:

- moderator roles
- approval workflows
- invite-only spaces
- paid member gating

## Suggested Module Layout

Recommended additions:

- `src/chat/`
- `src/content/`
- `src/feed/`
- `src/network/`
- `src/spaces/`
- `src/messages/`
- `src/products/`
- `src/authz/`
- `src/publish/`

Suggested responsibilities:

- `src/chat/`
  - runtime profiles
  - context compaction
  - tool registry
- `src/content/`
  - item schema
  - indexer
  - preview generation
- `src/feed/`
  - ranking
  - reels/grid assembly
- `src/network/`
  - node registration
  - relay routes
  - private/public resolution
- `src/spaces/`
  - space model
  - membership
  - invites

## Media Rendering Requirements

The UI must support:

- image viewer
- video viewer
- HTML renderer
- product card renderer

### Image

- thumbnails
- fullscreen
- metadata pane

### Video

- poster extraction
- duration extraction
- reels playback mode

### HTML

- safe rendering in iframe or sandboxed surface
- support exported pages and generated demos

### Products

- title
- price
- buy/test CTA
- linked media

## Payments and CDN

Do not build payments first.

Order:

1. local content pipeline
2. local UI
3. local-to-Tailscale publishing
4. user/content/product schema
5. CDN
6. payments

### CDN plan

CDN becomes relevant when:

- content is shared outside the tailnet
- videos need low-latency delivery
- image transforms are needed

Suggested abstraction:

- local origin remains source of truth
- CDN is an optional replication/output layer

The CDN should mainly serve:

- derived image variants
- public video streams
- static HTML snapshots
- public product media

It should not become the mandatory home for all user content.

### Payments plan

Payments should attach to products, not to the core content pipeline.

Initial payment scope:

- product page
- checkout link
- order metadata

Do not couple checkout to the first feed release.

## Generative Demoscene Roadmap

This is a major strategic branch, but it should come after the MVP foundation.

Target areas:

- real-time sketching
- Stable Diffusion pipelines
- 3D export
- generative HTML pages
- media remix from user folders

Current HII assets that help:

- `src/tools/comfyui.ts`
- `src/tools/comfyui-create.ts`
- `src/tools/rhino-to-comfy.ts`
- external 3D repos already present in `external/`

Recommended roadmap:

Phase A:

- local sketch-to-image workflows
- content item generation from prompts and local source images
- save outputs directly into HII content folders

Phase B:

- image-to-3D and mesh export pipeline
- content types for `scene` and `model`
- viewer integration for 3D assets

Phase C:

- real-time collaborative sketching
- live pipeline previews
- timeline/history of generated artifacts

## Architecture Recommendation

Introduce these modules before the UI gets too large:

- `src/content/`
  - indexing
  - metadata extraction
  - item schema
  - derived asset generation
- `src/feed/`
  - ranking
  - grouping
  - reels and grid assembly
- `src/publish/`
  - route mapping
  - local serving
  - tailscale integration
- `src/render/`
  - image/video/html/product render adapters
- `src/chat/`
  - separate interactive chat UI from CLI command wiring

Recommended near-term HTTP additions in `src/server.ts`:

- `GET /api/content`
- `GET /api/content/:id`
- `GET /api/feed`
- `GET /api/users/:id`
- `POST /api/publish/folder`
- `GET /api/publish/status`

Recommended future HTTP additions:

- `GET /api/spaces`
- `GET /api/spaces/:id`
- `GET /api/spaces/:id/feed`
- `GET /api/spaces/:id/messages`
- `POST /api/spaces/:id/messages`
- `POST /api/spaces`
- `POST /api/invites`
- `GET /api/inbox`
- `GET /api/products/:id`
- `POST /api/orders`

## Implementation Phases

### Phase 0: Stabilize local chat

Goal:

- make `hii chat` fast and reliable on user systems

Work:

- add chat profiles
- streamline backend selection
- reduce repeated prompt assembly
- add compaction
- add typed tool registry

### Phase 1: Local content index

Goal:

- turn local folders into HII-readable content collections

Work:

- folder registration
- content scanner
- metadata extraction
- thumbnail/poster generation
- content APIs

### Phase 2: Local UI

Goal:

- build a usable UI for reels and grid browsing

Work:

- feed shell
- user page
- content detail pages
- image/video/html/product renderers

### Phase 3: Publishing over Tailscale

Goal:

- let users expose their HII content privately and simply

Work:

- publishing commands
- route generation
- tailscale-compatible serving
- local auth model

### Phase 4: Products, CDN, payments

Goal:

- commercialize content without breaking the local-first model

Work:

- product schema
- checkout integration
- optional remote asset replication
- CDN-backed serving for public content

### Phase 5: Generative demoscene

Goal:

- make HII a creation environment, not just a publishing shell

Work:

- Stable Diffusion workflows
- 3D export pipeline
- real-time sketching
- generative page creation

### Phase 6: Communication network

Goal:

- make HII a user-focused communication and commerce network

Work:

- direct messaging
- private groups and channels
- space model
- shared content threads
- storefront/community unification
- private-net communication routing
- public directory to private-space conversion flow

## Build Order Recommendation

Do this in this order:

1. `hii chat` local-model efficiency
2. content indexing from user folders
3. feed APIs and item schema
4. reels/grid UI
5. Tailscale publishing
6. user pages
7. products
8. CDN
9. payments
10. generative demoscene expansion
11. communication network expansion

## What Not To Do Yet

Do not do these first:

- full public social graph
- complex recommendation ML
- heavy auth stack
- payments before content schema
- CDN before local publishing works
- 3D collaboration before image/video/page pipeline is stable

## Full Platform Spec

HII should be designed as a unified platform that combines the useful parts of:

- Discord
- YouTube
- Instagram
- Shopify

But it must not inherit their default platform logic.

Instead:

- communication is user-focused
- media is user-owned
- publishing is local-first
- commerce is attached to people, spaces, and content
- the global network indexes and connects rather than capturing everything

### Product surfaces

The platform should eventually include these primary surfaces:

1. `HII Chat`
2. `HII Feed`
3. `HII User Pages`
4. `HII Spaces`
5. `HII Storefronts`
6. `HII Creator Studio`
7. `HII Publish Layer`
8. `HII Global Directory`

### Surface goals

`HII Chat`

- local-first intelligence layer
- messaging, content lookup, and task execution
- communication with users, spaces, and content objects

`HII Feed`

- reels feed
- grid feed
- inbox and community feeds
- local, private, and public views

`HII User Pages`

- identity
- profile
- content tabs
- products
- social and commercial entrypoint

`HII Spaces`

- DMs
- groups
- channels
- communities
- project rooms
- private collaboration

`HII Storefronts`

- creator storefronts
- product pages
- gated drops
- paid private communities

`HII Creator Studio`

- content ingestion
- visibility control
- analytics that are user-facing and minimal
- publishing workflows
- generation workflows

`HII Publish Layer`

- local origin
- private relay
- public edge
- routing and delivery policy

`HII Global Directory`

- public discovery
- user and content search
- public feeds
- product discovery

## Domain Model

HII should revolve around a small set of durable platform entities.

### Core entities

- `User`
- `Device`
- `Identity`
- `Space`
- `Membership`
- `Message`
- `ContentItem`
- `Asset`
- `Product`
- `Offer`
- `Order`
- `ShareGrant`
- `VisibilityPolicy`
- `FeedEntry`
- `PublishTarget`

### `User`

Represents a human using HII.

Fields:

- `id`
- `handle`
- `displayName`
- `bio`
- `avatarAssetId`
- `publicPageEnabled`
- `primaryDeviceIds`
- `defaultVisibility`
- `createdAt`

### `Device`

Represents a user-controlled machine or node participating in HII.

Fields:

- `id`
- `userId`
- `deviceName`
- `networkAddress`
- `tailscaleIdentity`
- `capabilities`
- `lastSeenAt`
- `status`

### `Identity`

Represents public and private identity metadata.

Fields:

- `userId`
- `publicProfile`
- `privateProfile`
- `verificationState`
- `linkTargets`

### `Space`

Represents a communication and collaboration container.

Fields:

- `id`
- `type`
- `name`
- `description`
- `ownerUserId`
- `visibility`
- `membershipPolicy`
- `linkedContentIds`
- `linkedProductIds`
- `createdAt`

`Space.type` values:

- `dm`
- `group`
- `channel`
- `community`
- `storefront`
- `project-space`

### `Membership`

Represents a user's relationship to a space.

Fields:

- `spaceId`
- `userId`
- `role`
- `status`
- `joinedAt`

### `Message`

Represents communication inside HII.

Fields:

- `id`
- `spaceId`
- `senderUserId`
- `body`
- `contentRefs`
- `productRefs`
- `replyToMessageId`
- `visibility`
- `createdAt`
- `editedAt`

### `ContentItem`

Represents a user-facing publishable object.

Fields:

- `id`
- `ownerUserId`
- `type`
- `title`
- `summary`
- `caption`
- `tags`
- `sourcePath`
- `sourceDeviceId`
- `visibility`
- `assetIds`
- `derivedAssetIds`
- `linkedSpaceIds`
- `linkedProductIds`
- `publishState`
- `createdAt`
- `updatedAt`

`ContentItem.type` values:

- `image`
- `video`
- `page`
- `product`
- `audio`
- `document`
- `model3d`
- `scene`
- `post`

### `Asset`

Represents a concrete file or derivative.

Fields:

- `id`
- `contentItemId`
- `kind`
- `mimeType`
- `path`
- `checksum`
- `size`
- `width`
- `height`
- `duration`
- `storageClass`
- `availability`

`Asset.storageClass` values:

- `local-origin`
- `private-relay`
- `public-edge`
- `replicated`

### `Product`

Represents something that can be sold or gated.

Fields:

- `id`
- `ownerUserId`
- `title`
- `description`
- `price`
- `currency`
- `status`
- `mediaIds`
- `contentUnlockIds`
- `spaceUnlockIds`
- `checkoutProvider`

### `Offer`

Represents purchasable packaging.

Fields:

- `id`
- `productId`
- `kind`
- `price`
- `visibility`
- `rules`

`Offer.kind` values:

- `one-time`
- `subscription`
- `access-pass`
- `private-drop`

### `Order`

Represents a purchase record.

Fields:

- `id`
- `buyerUserId`
- `sellerUserId`
- `productId`
- `offerId`
- `status`
- `paymentProvider`
- `createdAt`

### `ShareGrant`

Represents a private sharing permission.

Fields:

- `id`
- `contentItemId`
- `granteeUserId`
- `granteeSpaceId`
- `scope`
- `previewOnly`
- `expiresAt`

### `VisibilityPolicy`

Represents policy for content and communications.

Fields:

- `id`
- `ownerUserId`
- `subjectType`
- `subjectId`
- `visibility`
- `rules`

### `FeedEntry`

Represents a ranked feed object.

Fields:

- `id`
- `feedType`
- `subjectType`
- `subjectId`
- `rank`
- `reason`
- `generatedAt`

### `PublishTarget`

Represents where and how something is exposed.

Fields:

- `id`
- `subjectType`
- `subjectId`
- `network`
- `route`
- `originMode`
- `cachePolicy`
- `authPolicy`

## Network Model

HII should use a layered network model.

### Layers

- `Local Runtime`
- `Private User Net`
- `Public Directory Network`
- `Optional Public Edge`

### Local Runtime

Runs on the user's machine.

Responsibilities:

- local chat
- local indexing
- local previews
- local storage
- source-of-truth operations

### Private User Net

Connects trusted users and devices.

Responsibilities:

- private sharing
- DM and group access
- original asset fetches
- work-in-progress collaboration

### Public Directory Network

Provides discovery and indexing.

Responsibilities:

- public profile metadata
- searchable content metadata
- global feed metadata
- public products and public routes

### Optional Public Edge

Accelerates explicitly public assets.

Responsibilities:

- thumbnails
- video transcodes
- static page snapshots
- public delivery of safe derivatives

## Product Behavior by Analogy

### Discord-equivalent layer

HII should replace:

- servers with `spaces`
- channels with `space feeds`
- DMs with private spaces
- media attachments with content refs
- role-gated communities with membership policies

But:

- spaces should link to user-owned content
- private files should not need permanent platform hosting
- communities should be portable and less platform-bound

### YouTube-equivalent layer

HII should replace:

- creator channels with user pages and spaces
- videos with `ContentItem(video)`
- playlists with feeds or collections
- subscriptions with follows and memberships

But:

- canonical media may remain user-controlled
- public edge copies are optional
- private and public video can coexist in one model

### Instagram-equivalent layer

HII should replace:

- visual feed
- profile grid
- stories/reels style browsing
- media-first discovery

But:

- the content graph should support richer content than only visual posts
- feed generation should stay legible
- user control should come before engagement optimization

### Shopify-equivalent layer

HII should replace:

- storefronts
- products
- checkout handoff
- creator commerce

But:

- commerce should attach directly to content, spaces, and identity
- storefronts should emerge from the same graph, not require a separate platform
- stores should remain portable and self-hostable
- the global directory should index stores instead of replacing them

## API Spec

The API should be split into local runtime APIs and network-facing APIs.

### Local runtime APIs

- `POST /api/chat`
- `POST /api/content/index-folder`
- `GET /api/content`
- `GET /api/content/:id`
- `GET /api/feed`
- `POST /api/feed/generate`
- `POST /api/publish/folder`
- `GET /api/publish/status`

### Identity and user APIs

- `GET /api/users/:id`
- `PATCH /api/users/:id`
- `GET /api/users/:id/content`
- `GET /api/users/:id/products`

### Space APIs

- `GET /api/spaces`
- `POST /api/spaces`
- `GET /api/spaces/:id`
- `PATCH /api/spaces/:id`
- `GET /api/spaces/:id/members`
- `POST /api/spaces/:id/invite`
- `GET /api/spaces/:id/feed`

### Messaging APIs

- `GET /api/spaces/:id/messages`
- `POST /api/spaces/:id/messages`
- `PATCH /api/messages/:id`
- `POST /api/messages/:id/react`
- `POST /api/messages/:id/share-content`

### Content and asset APIs

- `POST /api/content`
- `PATCH /api/content/:id`
- `GET /api/content/:id/assets`
- `POST /api/content/:id/visibility`
- `POST /api/content/:id/share`
- `GET /api/media/:id`

### Product and commerce APIs

- `GET /api/products`
- `POST /api/products`
- `GET /api/products/:id`
- `PATCH /api/products/:id`
- `POST /api/products/:id/offers`
- `POST /api/orders`
- `GET /api/orders/:id`
- `POST /api/checkout/session`

### Network and publish APIs

- `GET /api/net/status`
- `POST /api/net/connect`
- `POST /api/net/publish`
- `GET /api/net/routes`
- `POST /api/net/share-grant`

## Permission and Security Spec

HII needs two kinds of permissions:

1. runtime tool permissions
2. network/content permissions

### Runtime tool permissions

These govern:

- shell
- browser automation
- local file reads
- local file writes
- model execution
- background jobs

### Network/content permissions

These govern:

- who can see metadata
- who can access previews
- who can access originals
- who can join a space
- who can buy or unlock a product
- who can relay private content

### Required checks

Every networked content request should evaluate:

- actor identity
- space membership
- content visibility
- explicit share grants
- preview/original permission
- route/network being used

### Encryption and transport goals

Baseline:

- private-net traffic should be encrypted
- published public items should use signed or explicit publish policies
- user-to-user private sharing should avoid unnecessary third-party storage

## Storage Spec

HII should separate:

- metadata storage
- local source assets
- derived preview assets
- replicated public assets
- communication records
- purchase/access records

Suggested runtime layout under `~/.hii/`:

- `users/`
- `spaces/`
- `messages/`
- `content/`
- `assets/derived/`
- `feed/`
- `publish/`
- `orders/`
- `index/`

## UX Principles

HII should be:

- local-first
- accessible
- legible
- creator-friendly
- calm rather than addictive
- fast on normal hardware

### Accessibility goals

- keyboard-first navigation
- readable media metadata
- transcripts and captions where possible
- contrast-safe UI
- screen-reader-friendly page structure
- clear status and permission messaging

## Monetization Spec

HII should make money without undermining the self-hosted, user-first model.

That means:

- no adtech
- no behavioral surveillance
- no resale of user data
- no mandatory hosting lock-in

The right model is:

- free self-hosted core
- paid optional services
- paid acceleration and convenience
- paid professional and enterprise tooling

### Revenue principle

HII should monetize services around the network, not ownership of the user's identity or media.

Good revenue comes from:

- convenience
- reliability
- acceleration
- trust services
- commerce tooling
- premium workflows

Bad revenue comes from:

- exploiting attention
- collecting personal graph data
- locking users into mandatory hosted storage
- making private communication dependent on platform capture

## Revenue Models

### 1. Managed relay and private network services

Offer:

- managed private relay for users who do not want to self-operate private routing
- managed NAT traversal and connection brokerage
- managed uptime for private-net access

Why it fits:

- users keep content ownership
- HII charges for reliable connectivity and convenience
- aligns with the private-user-net architecture

### 2. Optional hosted public directory

Offer:

- hosted indexing of public pages, stores, spaces, and products
- verified public directory presence
- better search placement and richer public metadata features

Why it fits:

- the public directory is already a shared layer
- HII can charge for hosting and enhancement of the public index, not for taking content ownership

### 3. Edge acceleration and replication

Offer:

- optional image optimization
- optional public video transcoding
- public edge caching
- replication of explicitly public assets

Why it fits:

- origin stays user-controlled
- users pay only when they want stronger public performance

### 4. Premium creator studio tooling

Offer:

- advanced analytics for the creator's own content
- advanced publishing tools
- batch asset workflows
- richer storefront customization
- advanced feed and content organization tools

Why it fits:

- this is value-added tooling, not platform extraction
- especially relevant for artists, brands, labels, and community operators

### 5. Commerce infrastructure fees

Offer:

- checkout integrations
- order management tooling
- subscription and membership tooling
- tax/shipping/invoice add-ons later

Why it fits:

- users are already using HII for products and drops
- HII can earn from optional commerce infrastructure without owning the user's whole store

### 6. Paid private spaces and community plans

Offer:

- premium private spaces
- large-group management
- advanced moderation and trust tooling
- premium customer/community features

Why it fits:

- directly matches the Discord-replacement/community layer
- monetizes operational and trust features rather than attention

### 7. Professional identity and verification services

Offer:

- verified creator and store identity
- verified public addresses
- trusted seller status
- custom domains and branded routing

Why it fits:

- identity and trust are core to communication and commerce
- users pay for credibility and polish, not for forced hosting

### 8. Enterprise and organization deployment

Offer:

- managed deployment
- admin controls
- compliance controls
- enterprise directory integration
- private relay and edge bundles

Why it fits:

- enterprise comes later, after creator/community credibility
- uses the same network model, just with stronger governance

### 9. Generative creator tooling

Offer:

- premium generative workflows
- managed GPU execution
- advanced pipeline presets
- large asset generation and export

Why it fits:

- aligns with HII's creator studio and demoscene direction
- users can choose local generation or pay for managed acceleration

### 10. App and plugin ecosystem services

Offer:

- plugin distribution
- curated app marketplace
- premium integrations
- verified connectors

Why it fits:

- HII can become an ecosystem without forcing a closed platform model

## Monetization by Phase

### Early phase

Best-fit revenue:

- premium creator studio tools
- optional public directory hosting
- custom domains and identity verification

### Growth phase

Best-fit revenue:

- edge acceleration
- private relay subscriptions
- commerce infrastructure fees
- premium spaces and community plans

### Mature phase

Best-fit revenue:

- enterprise deployments
- managed networking
- advanced generative infrastructure
- premium app ecosystem services

## Monetization Guardrails

HII should never require users to give up core freedoms in order to use the network.

Required guardrails:

- self-hosted core remains usable
- export remains possible
- user media remains user-controlled by default
- private-net communication cannot require ad tracking
- analytics should be limited and creator-facing
- public directory participation should be optional
- public edge replication should be optional

## Business Model Summary

The clean model is:

- free protocol and self-hosted core
- paid managed network and delivery services
- paid creator and commerce tooling
- paid enterprise layers later

In short:

`HII should charge for convenience, trust, speed, and scale — not for ownership of human connection.`

## Implementation Structure

Recommended new module layout:

- `src/chat/`
- `src/content/`
- `src/assets/`
- `src/feed/`
- `src/identity/`
- `src/spaces/`
- `src/messages/`
- `src/products/`
- `src/orders/`
- `src/publish/`
- `src/net/`

## MVP-to-Platform Build Sequence

1. stabilize `hii chat`
2. build content indexing and asset derivation
3. add visibility states and publish routing
4. build reels/grid/user page UI
5. add spaces and basic messaging
6. add products and checkout
7. add public directory
8. add private-net communication and sharing depth
9. add richer creator studio flows
10. add generative demoscene and 3D workflows

## Monetization

HII should make money in ways that strengthen the user-owned network instead of fighting it.

The rule is:

`monetization should come from services, infrastructure, convenience, and commerce enablement — not surveillance, attention extraction, or compulsory hosting.`

### What HII should not do

Do not build revenue around:

- targeted ads
- data brokerage
- behavioral surveillance
- forced platform custody of all media
- locking creators into centralized hosting to monetize them later

### Revenue philosophy

HII's best business model is:

- the network stays user-first
- self-hosting remains real
- paid layers are optional
- HII earns by helping users connect, publish, relay, accelerate, sell, and operate

### Revenue layers

HII should eventually monetize through six layers:

1. managed network services
2. managed public directory and discovery services
3. creator and storefront tooling
4. commerce infrastructure
5. edge acceleration and replication
6. enterprise and community plans

### 1. Managed network services

This is the cleanest alignment with the private-net model.

Users should always be able to self-operate the private network layer, but HII can offer optional paid network services.

Examples:

- managed private relay
- managed identity routing
- managed NAT traversal and connection brokering
- reliable private share links
- managed invite and access services

Why it works:

- it monetizes convenience and reliability
- it does not require HII to own every user asset
- it strengthens private-net communication

### 2. Managed public directory and discovery

The public directory can be self-hostable in theory, but HII can monetize the operated global directory.

Examples:

- public creator directory listing
- search indexing
- ranking and recommendation infrastructure
- public profile verification
- featured discovery surfaces

Why it works:

- the directory is a network utility
- users benefit from shared discoverability
- HII earns from operating the connective tissue rather than seizing user origin assets

### 3. Creator and storefront tooling

HII can charge for premium tools around creator operation.

Examples:

- advanced storefront themes
- premium analytics dashboards
- advanced drop tooling
- premium creator studio workflows
- campaign and launch tooling
- richer publishing automation

Why it works:

- creators already pay for operational leverage
- this preserves self-hosting while monetizing better workflows

### 4. Commerce infrastructure

HII can monetize the commerce layer without becoming extractive.

Examples:

- checkout integration fees
- optional transaction fees on HII-hosted commerce services
- subscription tools
- gated community tooling
- order, offer, and entitlement infrastructure

Why it works:

- users are paying for commerce enablement
- the fee can be tied to successful transactions rather than surveillance

### 5. Edge acceleration and replication

HII can offer optional edge services for public content and storefronts.

Examples:

- image optimization
- video transcoding
- global caching
- replicated product media
- public asset CDN layer

Why it works:

- it monetizes bandwidth, speed, and reliability
- it only becomes necessary when users want scale
- it does not need to replace local origin for private content

### 6. Enterprise and community plans

Enterprise should come later, but it is a real revenue path.

Examples:

- managed private-community deployments
- org-wide identity and trust controls
- team relay infrastructure
- enterprise-grade compliance and admin tooling
- hosted internal directory and communication surfaces

Why it works:

- HII's private/public architecture maps well to organizations
- enterprise pays for reliability, admin, and governance

## Recommended Revenue Sequence

Build revenue in this order:

1. premium creator/storefront tooling
2. managed private relay and network services
3. checkout and commerce services
4. public directory and discovery services
5. edge acceleration and replication
6. enterprise/community plans

This order matches the product build sequence and avoids overbuilding infrastructure before the user network is alive.

## Monetization Models That Fit HII

### Model A: Free self-hosted core + paid managed relay

Best for:

- private networking
- communication
- trusted sharing

This is likely one of the strongest revenue paths because it aligns directly with the two-network model.

### Model B: Free self-hosted store + paid discovery and growth tools

Best for:

- creators
- clothing lines
- music collectives
- niche brands

This fits the "free self-hosted Shopify plus global directory" framing.

### Model C: Free publishing + paid public edge

Best for:

- media-heavy creators
- video-heavy pages
- public drops and launches

This charges for scale and speed rather than access to basic ownership.

### Model D: Commerce fee on optional hosted checkout

Best for:

- simple monetization
- early storefronts
- paid communities

The key is that the fee should attach to checkout services, not to ownership of the store.

### Model E: Premium creator studio

Best for:

- advanced publishing
- generative tooling
- premium launch tooling
- analytics and automation

This makes sense once HII becomes a true creator operating system.

### Model F: Enterprise private-net plans

Best for:

- teams
- orgs
- creative businesses
- internal communication and media routing

This should come after cultural and creator legitimacy is established.

## Suggested Pricing Logic

HII should keep the self-hosted core generous.

Possible pricing logic:

- free local runtime
- free self-hosted publishing
- paid managed relay and directory boosts
- paid public edge/CDN usage
- paid premium creator tools
- transaction-linked commerce fees only when HII is powering checkout
- enterprise plans for governance and reliability

## Why This Revenue Model Fits The Mission

This revenue structure keeps HII aligned with:

- user ownership
- human connection
- low surveillance
- open-web values
- self-hosting
- creator autonomy

It lets HII make money by helping users do more, not by taking more from them.

## Immediate Next Step

The next implementation task should be:

`Refactor hii chat into a dedicated runtime with local-model profiles, typed tool registry, and context compaction.`

That work creates the foundation for the content pipeline, feed generation, local publishing, and future generative workflows.

The implementation task immediately after that should be:

`Add content visibility states and a two-network publish layer with local origin, private relay, and public directory routing.`
