# HII Evidence Inventory

Generated: 2026-09-14T22:49:55.115Z
Base checkout commit at generation: 210266bc
Regenerate: `node scripts/hii-inventory.mjs --write-docs`

A source declaration is an implementation lead. Working means a live or installed probe answered; in-progress means present without end-to-end proof; planned means declared for later.

## Installed and live

| Item | State | Evidence |
| --- | --- | --- |
| CLI binary | working | /Users/ummi/hii/target/release/hii |
| Desktop app | in-progress | /Applications/HII.app; launch unverified |
| native-mlx | working | http://127.0.0.1:11435; health endpoint answered |
| private-gateway | in-progress | no endpoint; gateway offline |

Imported conversations: chatgpt 496, codex 692; last sync 2026-09-14T22:49:18.386Z.

## Devices

| Item | State | Evidence |
| --- | --- | --- |
| windows-pc | in-progress | windows-pc; executor pending-agent |
| Tailscale iphone (100.87.158.79) | in-progress | transport only; application unverified |
| Tailscale localhost (100.114.146.113) | in-progress | transport only; application unverified |
| Tailscale localhost (100.76.69.22) | in-progress | transport only; application unverified |
| Tailscale pc (100.81.69.126) | working | transport only; application unverified |

## CLI commands

| Command | State | Evidence |
| --- | --- | --- |
| inventory | in-progress | delegated; Context; cli/src/route.rs |
| archive | in-progress | delegated; Context; cli/src/route.rs |
| session-backup | in-progress | native; Infrastructure; cli/src/route.rs |
| home | in-progress | delegated; Context; cli/src/route.rs |
| run | in-progress | native; Work; cli/src/route.rs |
| ask | in-progress | native; Work; cli/src/route.rs |
| work | in-progress | delegated; Work; cli/src/route.rs |
| task | in-progress | delegated; Work; cli/src/route.rs |
| now | in-progress | delegated; Work; cli/src/route.rs |
| chat | in-progress | split; Work; cli/src/route.rs |
| check | in-progress | delegated; Build; cli/src/route.rs |
| ship | in-progress | delegated; Build; cli/src/route.rs |
| proof | in-progress | native; Work; cli/src/route.rs |
| stream | in-progress | native; Work; cli/src/route.rs |
| board | in-progress | native; Work; cli/src/route.rs |
| state | in-progress | native; Work; cli/src/route.rs |
| status | in-progress | native; Infrastructure; cli/src/route.rs |
| doctor | in-progress | native; Infrastructure; cli/src/route.rs |
| find | in-progress | native; Tools; cli/src/route.rs |
| models | in-progress | native; Infrastructure; cli/src/route.rs |
| model | in-progress | delegated; Infrastructure; cli/src/route.rs |
| open | in-progress | delegated; Infrastructure; cli/src/route.rs |
| ui | in-progress | delegated; Infrastructure; cli/src/route.rs |
| app | in-progress | delegated; Infrastructure; cli/src/route.rs |
| slash | in-progress | delegated; Infrastructure; cli/src/route.rs |
| providers | in-progress | native; Infrastructure; cli/src/route.rs |
| login | in-progress | native; Infrastructure; cli/src/route.rs |
| clean | in-progress | native; Infrastructure; cli/src/route.rs |
| agent | in-progress | native; Work; cli/src/route.rs |
| receipt | in-progress | native; Work; cli/src/route.rs |
| terminal | in-progress | native; Tools; cli/src/route.rs |
| share | in-progress | native; Context; cli/src/route.rs |
| context | in-progress | split; Context; cli/src/route.rs |
| apps | in-progress | native; Tools; cli/src/route.rs |
| presence | in-progress | native; Context; cli/src/route.rs |
| link | in-progress | native; Infrastructure; cli/src/route.rs |
| systems | in-progress | native; Infrastructure; cli/src/route.rs |
| network | in-progress | native; Infrastructure; cli/src/route.rs |
| ecosystem | in-progress | native; Infrastructure; cli/src/route.rs |
| on | in-progress | native; Infrastructure; cli/src/route.rs |
| discover | in-progress | native; Tools; cli/src/route.rs |
| skills | in-progress | split; Tools; cli/src/route.rs |
| info | in-progress | native; Context; cli/src/route.rs |
| web | in-progress | native; Tools; cli/src/route.rs |
| pipe | in-progress | native; Tools; cli/src/route.rs |
| usefulness | in-progress | native; Infrastructure; cli/src/route.rs |
| service | in-progress | native; Infrastructure; cli/src/route.rs |
| notify | in-progress | native; Infrastructure; cli/src/route.rs |
| project | in-progress | native; Work; cli/src/route.rs |
| thread | in-progress | native; Work; cli/src/route.rs |
| interact | in-progress | native; Work; cli/src/route.rs |
| schedule | in-progress | native; Infrastructure; cli/src/route.rs |
| tools | in-progress | native; Tools; cli/src/route.rs |
| capture | in-progress | delegated; Work; cli/src/route.rs |
| loop | in-progress | delegated; Work; cli/src/route.rs |
| health | in-progress | delegated; Infrastructure; cli/src/route.rs |
| agents | in-progress | delegated; Context; cli/src/route.rs |
| agent-context | in-progress | delegated; Context; cli/src/route.rs |
| og | in-progress | delegated; Context; cli/src/route.rs |
| knowledge | in-progress | delegated; Context; cli/src/route.rs |
| links | in-progress | delegated; Context; cli/src/route.rs |
| feed | in-progress | delegated; Context; cli/src/route.rs |
| pack | in-progress | delegated; Context; cli/src/route.rs |
| probe | in-progress | delegated; Infrastructure; cli/src/route.rs |
| caps | in-progress | delegated; Infrastructure; cli/src/route.rs |
| jobs | in-progress | delegated; Infrastructure; cli/src/route.rs |
| daemon | in-progress | delegated; Infrastructure; cli/src/route.rs |
| instances | in-progress | delegated; Infrastructure; cli/src/route.rs |
| runner | in-progress | delegated; Infrastructure; cli/src/route.rs |
| registry | in-progress | delegated; Infrastructure; cli/src/route.rs |
| space | in-progress | delegated; Infrastructure; cli/src/route.rs |
| money | in-progress | delegated; Infrastructure; cli/src/route.rs |
| objects | in-progress | delegated; Infrastructure; cli/src/route.rs |
| object | in-progress | delegated; Infrastructure; cli/src/route.rs |
| sdk | in-progress | delegated; Tools; cli/src/route.rs |
| console | in-progress | delegated; Tools; cli/src/route.rs |
| bridge | in-progress | delegated; Tools; cli/src/route.rs |
| codex | in-progress | delegated; Tools; cli/src/route.rs |
| skill | in-progress | delegated; Tools; cli/src/route.rs |
| dev | in-progress | delegated; Build; cli/src/route.rs |
| build | in-progress | delegated; Build; cli/src/route.rs |
| start | in-progress | delegated; Build; cli/src/route.rs |
| mcp | in-progress | native; Tools; cli/src/route.rs |
| completions | in-progress | native; Infrastructure; cli/src/route.rs |

## Agent tools

| Tool | State | Evidence |
| --- | --- | --- |
| read | in-progress | local; read-only; cli/src/acp.rs |
| list | in-progress | local; read-only; cli/src/acp.rs |
| search | in-progress | local; read-only; cli/src/acp.rs |
| web_search | in-progress | network; read-only; cli/src/acp.rs |
| image_search | in-progress | network; read-only; cli/src/acp.rs |
| web_fetch | in-progress | network; read-only; cli/src/acp.rs |
| write | in-progress | local; mutates; cli/src/acp.rs |
| edit | in-progress | local; mutates; cli/src/acp.rs |
| app_uninstall | in-progress | local; mutates; cli/src/acp.rs |
| shell | in-progress | exec; mutates; cli/src/acp.rs |
| verify | in-progress | exec; read-only; cli/src/acp.rs |
| http | in-progress | network; read-only; cli/src/acp.rs |
| mcp_call | in-progress | mcp; mutates; cli/src/acp.rs |
| hii_context | in-progress | hii; read-only; cli/src/acp.rs |
| config_read | in-progress | hii; read-only; cli/src/acp.rs |
| config_write | in-progress | hii; mutates; cli/src/acp.rs |
| canvas_list | in-progress | hii; read-only; cli/src/acp.rs |
| canvas_read | in-progress | hii; read-only; cli/src/acp.rs |
| canvas_add | in-progress | hii; mutates; cli/src/acp.rs |
| canvas_update | in-progress | hii; mutates; cli/src/acp.rs |
| info_find | in-progress | hii; read-only; cli/src/acp.rs |
| info_capture | in-progress | hii; mutates; cli/src/acp.rs |
| og_next | in-progress | hii; read-only; cli/src/acp.rs |
| caps_check | in-progress | hii; read-only; cli/src/acp.rs |
| board_read | in-progress | hii; read-only; cli/src/acp.rs |
| board_write | in-progress | hii; mutates; cli/src/acp.rs |
| skill_search | in-progress | hii; read-only; cli/src/acp.rs |
| schedule_read | in-progress | hii; read-only; cli/src/acp.rs |
| schedule_write | in-progress | hii; mutates; cli/src/acp.rs |
| system_status | in-progress | hii; read-only; cli/src/acp.rs |
| system_observe | in-progress | hii; read-only; cli/src/acp.rs |
| object_list | in-progress | hii; read-only; cli/src/acp.rs |
| object_read | in-progress | hii; read-only; cli/src/acp.rs |
| agent_send | in-progress | hii; mutates; cli/src/acp.rs |
| bridge_send | in-progress | hii; mutates; cli/src/acp.rs |
| bridge_read | in-progress | hii; read-only; cli/src/acp.rs |

## Product features

| Feature | State | Source claim |
| --- | --- | --- |
| runtime.object-graph | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| runtime.event-history | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| runtime.authority | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| runtime.provenance | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| runtime.verification | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| runtime.portability | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| runtime.capability-formation | planned | next; harness; docs/HII_FEATURE_REGISTRY.yaml |
| space.canvas | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.cli | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.terminal | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.drawing | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.browser | planned | next; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.mobile | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.evoked-interfaces | planned | next; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.orientation | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.board | planned | next; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.feed | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| space.watch | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.work | in-progress | now; space; docs/HII_FEATURE_REGISTRY.yaml |
| space.interform | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.universal-save | planned | next; harness; docs/HII_FEATURE_REGISTRY.yaml |
| object.message | planned | next; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.profile | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.publication | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.offer | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.decision | planned | next; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.web-page | planned | next; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.geometry | planned | later; space; docs/HII_FEATURE_REGISTRY.yaml |
| object.application | in-progress | experimental; space; docs/HII_FEATURE_REGISTRY.yaml |
| harness.context-pack | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.memory | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.conversation-import | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.agent-coordination | in-progress | now; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.browser-research | planned | next; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.mail-import | planned | later; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.rhino | planned | next; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.form-compiler | planned | later; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.foundry | planned | later; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.teach-hii | planned | later; harness; docs/HII_FEATURE_REGISTRY.yaml |
| harness.personal-operations | planned | later; harness; docs/HII_FEATURE_REGISTRY.yaml |
| network.identity | in-progress | now; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.live-reference | in-progress | now; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.snapshot-fork-export | in-progress | now; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.direct-relay | in-progress | now; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.messages | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.social-graph | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.realtime-calls | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.federation | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.moderation | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.physical-space | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.publication | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.marketplace | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.lrx | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.fabrication | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |
| network.commerce | planned | later; network; docs/HII_FEATURE_REGISTRY.yaml |

## Limits

- Source declarations do not prove installed behavior.
- Tailscale presence does not prove the HII executor is ready.
- A present desktop app is not launch proof.
- Planned registry entries are not advertised as available actions.
