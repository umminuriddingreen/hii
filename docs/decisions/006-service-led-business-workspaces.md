# ADR 006: Service-Led Business Workspaces

**Status:** Accepted
**Date:** 2026-08-30

## Decision

HII's enterprise entry model is concierge onboarding into an account-owned,
durable business workspace. Ummi's studio sells and delivers a concrete
operational outcome—such as a storefront, content system, inventory workflow,
or campaign surface—and the customer then operates that business through HII.

The customer-facing website and the owner-facing HII interface are projections
over the same typed business objects, capabilities, approvals, and receipts.
They must not become separate custom backends. Bespoke presentation is expected:
the reusable product is the hidden HII substrate, while each client surface is
art-directed around the work, brand, and decisions that matter to that business.

## Ownership and studio authority

- A customer account owns its workspace and business data.
- The owner may issue a single-use, expiring share code for a specific role.
- Ummi may redeem an owner-issued code to become a workspace-scoped studio
  administrator. This is not global account impersonation or a platform backdoor.
- Studio authority is visible, revocable, and recorded in the workspace event
  history. Revocation ends future access without transferring ownership.
- Owners, studio administrators, employees, and viewers use distinct roles.
- Publishing, purchases, customer messaging, destructive changes, credential
  access, and other consequential capabilities retain their own approval gates;
  workspace administration alone does not silently authorize them.

## Surface and synchronization model

```text
customer account ─┐
                  ├─ account-owned business workspace
studio admin grant┘          │
                             ├─ owner HII surface
                             ├─ studio HII surface
                             ├─ customer-facing website/store
                             └─ bounded business capabilities + receipts
```

Web and installed HII clients synchronize the same workspace projection through
an authenticated account/device adapter. Native terminal, filesystem, local
models, and machine control remain capabilities of a specifically paired,
trusted device; synchronizing a terminal object does not grant browser shell
authority.

## Product discipline

- Early customers are manually provisioned design partners.
- Record every manual onboarding operation and promote repeated, verified work
  into an HII capability.
- Build missing HII capabilities required by a client; do not create a private
  parallel control plane for that client.
- Custom dashboards are projections, not new stores or authorities.
- The default client surface should be calm and task-specific, with complexity
  available only where the role and workflow require it.

## First proof

1. A customer creates or opens an account workspace.
2. The customer issues a short-lived studio-admin share code.
3. Ummi redeems it from her own account.
4. Both accounts see and edit the same workspace revision.
5. The customer revokes the membership and Ummi can no longer read or write it.
6. Each transition leaves an account/workspace event with actor, role, time,
   revision, and bounded detail.

Media blobs, live terminal transport, commerce writes, and production deployment
require their own end-to-end proofs and are not implied by document sync.

## HII Social and notifications

Communication belongs to the same account and workspace graph rather than a
separate social identity silo. A workspace may contain direct conversations,
team channels, call records, and notification preferences whose membership is
derived from current workspace authority.

- Text messages are durable workspace objects with sender, recipients, time,
  delivery state, and moderation or deletion receipts.
- Voice and video use browser-native encrypted media transport. The HII service
  brokers short-lived call invitations and signaling only; microphone, camera,
  screen sharing, recording, and remote control each require an explicit grant.
- Calls can be started or answered from any authenticated HII surface. A device
  advertises only the media capabilities it can actually execute.
- Email is an opt-in notification projection, not the canonical conversation.
  A transactional outbox records the triggering event, recipient preference,
  provider delivery identifier, and final status. Workspace messages do not
  silently become external email.
- Revoking workspace membership immediately prevents new messages, calls, and
  notifications in that workspace without deleting the retained audit history.
