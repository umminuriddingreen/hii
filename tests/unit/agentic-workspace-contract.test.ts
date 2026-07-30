import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/lib/components/workspace/WorkspacePage.svelte'), 'utf8');
const chat = readFileSync(resolve(root, 'src/lib/components/workspace/ChatPane.svelte'), 'utf8');
const spatialRun = readFileSync(resolve(root, 'src/lib/components/workspace/SpatialRunPane.svelte'), 'utf8');
const runProgress = readFileSync(resolve(root, 'lib/workspace/run-progress.ts'), 'utf8');
const runBoundary = readFileSync(resolve(root, 'lib/workspace/run-boundary.ts'), 'utf8');
const workspaceRuns = readFileSync(resolve(root, 'lib/server/hii-workspace-runs.ts'), 'utf8');
const workspaceRunContext = readFileSync(resolve(root, 'lib/server/hii-workspace-run-context.ts'), 'utf8');
const workspaceRunStaging = readFileSync(resolve(root, 'aii/daemon/workspace-run-staging.mjs'), 'utf8');
const workspaceRunRoute = readFileSync(resolve(root, 'app/api/workspace/runs/route.ts'), 'utf8');
const workspaceAssetsRoute = readFileSync(resolve(root, 'app/api/workspace/assets/route.ts'), 'utf8');
const terminalServer = readFileSync(resolve(root, 'lib/server/hii-terminal.ts'), 'utf8');
const workspaceArtifacts = readFileSync(resolve(root, 'lib/server/hii-workspace-artifacts.ts'), 'utf8');
const workspaceArtifactRoute = readFileSync(resolve(root, 'app/api/workspace/artifacts/route.ts'), 'utf8');
const apiBridge = readFileSync(resolve(root, 'src/routes/api/[...path]/+server.ts'), 'utf8');
const runArtifactPane = readFileSync(resolve(root, 'src/lib/components/workspace/RunArtifactPane.svelte'), 'utf8');
const hiid = readFileSync(resolve(root, 'aii/daemon/hiid.mjs'), 'utf8');
const daemonHealth = readFileSync(resolve(root, 'lib/workspace/daemon-health.ts'), 'utf8');
const hiiDaemon = readFileSync(resolve(root, 'lib/server/hii-daemon.ts'), 'utf8');
const knowledgeRuns = readFileSync(resolve(root, 'lib/server/hii-knowledge-runs.ts'), 'utf8');
const explorer = readFileSync(resolve(root, 'src/lib/components/workspace/ExplorerPane.svelte'), 'utf8');
const terminal = readFileSync(resolve(root, 'src/lib/components/TerminalPane.svelte'), 'utf8');
const desktop = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
const desktopBuild = readFileSync(resolve(root, 'scripts/hii-tauri-build.mjs'), 'utf8');
const desktopInstall = readFileSync(resolve(root, 'scripts/hii-tauri-install.mjs'), 'utf8');
const desktopRelease = readFileSync(resolve(root, 'scripts/hii-macos-release.mjs'), 'utf8');
const cursorBar = readFileSync(resolve(root, 'src/routes/palette/+page.svelte'), 'utf8');
const staticNode = readFileSync(resolve(root, 'src/lib/components/workspace/StaticNode.svelte'), 'utf8');
const documentPane = readFileSync(resolve(root, 'src/lib/components/workspace/DocumentPane.svelte'), 'utf8');
const cadPane = readFileSync(resolve(root, 'src/lib/components/workspace/CadPane.svelte'), 'utf8');
const modelPane = readFileSync(resolve(root, 'src/lib/components/workspace/ModelPane.svelte'), 'utf8');
const contextAnchor = readFileSync(resolve(root, 'lib/workspace/context-anchor.ts'), 'utf8');
const workspaceIngest = readFileSync(resolve(root, 'lib/workspace/ingest.ts'), 'utf8');
const pendingContext = readFileSync(resolve(root, 'lib/workspace/pending-context.ts'), 'utf8');
const workspaceNavigator = readFileSync(resolve(root, 'src/lib/components/workspace/WorkspaceNavigator.svelte'), 'utf8');
const workspaceOutline = readFileSync(resolve(root, 'lib/workspace/outline.ts'), 'utf8');
const workspaceOrganize = readFileSync(resolve(root, 'lib/workspace/organize.ts'), 'utf8');
const chatOutput = readFileSync(resolve(root, 'lib/workspace/chat-output.ts'), 'utf8');
const boardRun = readFileSync(resolve(root, 'lib/workspace/board-run.ts'), 'utf8');

describe('agentic workspace interaction contract', () => {
  it('summons direct workspace intent from Option+Space', () => {
    expect(workspace).toContain("event.altKey&&event.code==='Space'");
    expect(workspace).toContain("listen('hii://summon'");
    expect(workspace).toContain("window.addEventListener('hii:summon'");
    expect(workspace).toContain('approved context');
    expect(workspace).toContain("seedFor('intent'");
    expect(workspace).toContain("seedFor('run'");
    expect(spatialRun).toContain('Approve bounded run');
    expect(spatialRun).toContain("action: 'approve'");
  });

  it('keeps dense canvases navigable as scenes plus governed object lineage', () => {
    expect(workspace).toContain('<WorkspaceNavigator');
    expect(workspaceNavigator).toContain('Workspace outline');
    expect(workspaceNavigator).toContain('Find an intent, run, receipt, or object');
    expect(workspaceOutline).toContain("title: 'Loose objects'");
    expect(workspaceNavigator).toContain('workspaceFlattenOutlineEntries');
    expect(workspaceOutline).toContain('[node.object?.parentId, node.payload.parentId]');
    expect(workspaceOutline).toContain('statusCounts');
  });

  it('turns exact human selection into reversible Scene structure', () => {
    expect(workspace).toContain('organizeWorkspaceSelection(doc,contextSelection)');
    expect(workspace).toContain('aria-label="Organize selection into scene"');
    expect(workspace).toContain('Make Scene');
    expect(workspace).toContain("changeHistory('undo')");
    expect(workspace).toContain('onSelectNodes={selectShownNodes}');
    expect(workspaceNavigator).toContain('Select {visibleNodes.length}');
    expect(workspaceNavigator).toContain('onSelectNodes(visibleNodes)');
    expect(workspaceOrganize).toContain("membership: 'explicit-selection'");
    expect(workspaceOrganize).toContain("action: 'organized explicit workspace selection into scene'");
    expect(workspaceOrganize).toContain("node.type !== 'frame'");
  });

  it('hands selected context to the real AII workspace runner and branches from its receipt', () => {
    expect(workspace).toContain('selectedContextNodes');
    expect(spatialRun).toContain('Execution context manifest');
    expect(spatialRun).toContain('/api/workspace/runs');
    expect(spatialRun).toContain('setTimeout(resolve, 1000)');
    expect(workspaceRuns).toContain("kind: 'workspace.run'");
    expect(workspaceRuns).toContain('Explicit approval is required');
    expect(workspaceRunRoute).toContain('queueApprovedWorkspaceRun');
    expect(spatialRun).toContain('onFollowUp(text)');
    expect(workspace).toContain('parentId:intentNode.id');
    expect(chat).toContain('run.visibleOutput');
  });

  it('shows the effective read authority and fails closed for secret-like context', () => {
    expect(spatialRun).toContain('Read boundary');
    expect(spatialRun).toContain('Secret policy');
    expect(spatialRun).toContain('boundaryManifest.blocked');
    expect(runBoundary).toContain('other non-secret files inside');
    expect(runBoundary).toContain('assertWorkspaceRunContextSafe');
    expect(workspaceRunContext).toContain('sensitiveWorkspaceContextSource(source)');
    expect(workspaceRuns).toContain('contextPreview.blocked');
  });

  it('binds approval to an executable context manifest rather than decorative node labels', () => {
    expect(workspace).toContain('contextExcerpt(node)');
    expect(workspace).toContain('proofRefs:(node.object?.proofRefs||[])');
    expect(spatialRun).toContain('Execution context manifest');
    expect(spatialRun).toContain("action: 'preview-context'");
    expect(spatialRun).toContain('contextFingerprint: contextPreview?.fingerprint');
    expect(spatialRun).toContain('Network boundary');
    expect(workspaceRuns).toContain('approvedFingerprint !== contextPreview.fingerprint');
    expect(workspaceRunContext).toContain('content-hashed file inside approved workspace root');
    expect(workspaceRunContext).toContain('outbound read-only web retrieval');
    expect(workspaceRunContext).toContain('Approved snapshot:');
    expect(hiid).toContain('String(intent.goal).slice(0, 16000)');
  });

  it('stages explicitly selected local creative assets without widening runner authority', () => {
    expect(workspace).toContain("expectedSha256:String(node.payload.sha256||'')");
    expect(spatialRun).toContain("runId: node.id");
    expect(spatialRun).toContain('run copy · {item.stagedRelativePath}');
    expect(workspaceAssetsRoute).toContain("storage: 'hii-content-addressed'");
    expect(workspaceAssetsRoute).toContain("flag: 'wx'");
    expect(terminalServer).toContain("process.env.HII_TAURI === '1'");
    expect(desktop).toContain('.env("ORIGIN", format!("http://127.0.0.1:{port}"))');
    expect(desktop).toContain('.env("BODY_SIZE_LIMIT", "251M")');
    expect(workspaceRunContext).toContain("'staged-local-asset'");
    expect(workspaceRunContext).toContain("path.join('.hii-run-context', runId");
    expect(workspaceRunStaging).toContain('A selected local asset changed after context approval.');
    expect(workspaceRunStaging).toContain('fs.constants.COPYFILE_EXCL');
    expect(workspaceRunStaging).toContain('cleanupStatus: "skipped-unowned"');
    expect(hiid).toContain('stageWorkspaceRunContext');
    expect(hiid).toContain('cleanupWorkspaceRunContext');
  });

  it('binds the human selected part of an asset to the same governed run manifest', () => {
    expect(workspace).toContain('normalizeWorkspaceContextAnchor(node.payload.contextAnchor)');
    expect(spatialRun).toContain('human focus · {workspaceContextAnchorLabel(item.anchor)}');
    expect(workspaceRunContext).toContain('anchor: item.anchor || null');
    expect(workspaceRunContext).toContain('Context anchor:');
    expect(workspaceRunStaging).toContain('anchor: item.anchor || null');
    expect(contextAnchor).toContain("'document-range'");
    expect(contextAnchor).toContain("'image-region'");
    expect(contextAnchor).toContain("'design-selection'");
    expect(contextAnchor).toContain("'drawing-view'");
    expect(contextAnchor).toContain("'media-range'");
    expect(contextAnchor).toContain("'model-view'");
    expect(documentPane).toContain('use pages');
    expect(staticNode).toContain('focus region');
    expect(staticNode).toContain('use selection');
    expect(staticNode).toContain("markMedia('in')");
    expect(cadPane).toContain('useDrawingView');
    expect(modelPane).toContain('useModelView');
    expect(workspaceIngest).toContain("anchorAdapter: 'design-selection'");
    expect(workspace).toContain('rebindPendingWorkspaceContext');
    expect(pendingContext).toContain("contextPreview: null");
    expect(spatialRun).toContain('focus refreshed');
    expect(spatialRun).toContain('requestedContextSignature !== contextSignature');
  });

  it('keeps governed progress concise and raw execution output behind inspection', () => {
    expect(spatialRun).toContain('workspaceRunProgress');
    expect(spatialRun).toContain('Inspect evidence');
    expect(spatialRun).toContain('Raw execution log');
    expect(spatialRun).toContain('{#if rawEvidenceOpen}');
    expect(spatialRun).toContain('on:pointerdown|stopPropagation');
    expect(spatialRun).toContain("patchRun(run.job.status, { job: run.job })");
    expect(spatialRun).toContain('terminalRunMessage(status)');
    expect(runProgress).toContain("'approval' | 'queue' | 'work' | 'proof' | 'receipt'");
    expect(runProgress).toContain('No verified receipt was returned.');
    expect(chat).toContain('workspaceChatPresentation');
    expect(chat).toContain('Inspect');
    expect(chat).toContain('run details');
    expect(chat).toContain('{#if rawOpen.has(message.id)}');
    expect(chatOutput).toContain('visibleRunOutput(text)');
    expect(chatOutput).toContain('legacyTranscript: true');
  });

  it('uses the installed HII model default and preserves truthful terminal failures', () => {
    expect(workspace).toContain("model:''");
    expect(workspaceRuns).toContain("defaultWorkspaceRunModel = 'qwen3.6:35b-mlx'");
    expect(workspaceRuns).toContain('discoverWorkspaceRunModels');
    expect(workspaceRuns).toContain('is not installed');
    expect(workspaceRunRoute).toContain("params.get('mode') === 'models'");
    expect(knowledgeRuns).not.toContain('supportedModels');
    expect(knowledgeRuns).toContain('model: input.model');
    expect(spatialRun).toContain('Installed local model');
    expect(spatialRun).toContain("let error = String(node.payload.error || '')");
    expect(spatialRun).toContain("error: failureError");
    expect(spatialRun).toContain("status === 'failed'");
    expect(runProgress).toContain('Inspect its evidence for the final execution output.');
    expect(spatialRun).toContain('Branch a revised intent from this run…');
  });

  it('lets AII stop, reconcile, and safely retry bounded workspace runs', () => {
    expect(spatialRun).toContain('Stop bounded run');
    expect(spatialRun).toContain("action: 'cancel'");
    expect(spatialRun).toContain('Prepare fresh retry for approval');
    expect(workspaceRuns).toContain("kind: 'workspace.cancel'");
    expect(workspaceRunRoute).toContain('requestWorkspaceRunCancellation');
    expect(hiid).toContain('activeWorkspaceRuns');
    expect(hiid).toContain('cancelWorkspaceIntent');
    expect(hiid).toContain('reconcileWorkspaceRuns');
    expect(hiid).toContain('if (terminal?.status === "cancelled") {');
    expect(hiid).toContain('reportWorkspaceJob(terminalIntent');
  });

  it('shows operator-meaningful runtime health instead of unexplained process counts', () => {
    expect(workspace).not.toContain("hiid {daemon?.instances?.length");
    expect(workspace).toContain('runtimeHealth.label');
    expect(workspace).toContain('AII runtime health');
    expect(workspace).toContain('observed workstation processes');
    expect(workspace).toContain('controlDaemon(runtimeHealth.recoveryAction)');
    expect(daemonHealth).toContain("'ready' | 'busy' | 'attention' | 'offline'");
    expect(hiiDaemon).toContain('summarizeHiiDaemonHealth');
  });

  it('materializes proof lineage and keeps capability promotion operator-reviewed', () => {
    expect(workspace).toContain("kind:'artifact'");
    expect(workspace).toContain("kind:'receipt'");
    expect(workspace).toContain("kind:'capability'");
    expect(workspace).toContain('workspaceConnections');
    expect(spatialRun).toContain('Save verified run as capability draft');
    expect(workspaceRuns).toContain('createWorkspaceRunCapabilityDraft');
    expect(workspaceRuns).toContain("'--repeatable'");
    expect(workspaceRuns).not.toContain('skill register');
  });

  it('carries approved board work through bounded execution and back to its receipt', () => {
    expect(workspace).toContain('Prepare bounded run');
    expect(workspace).toContain('createBoardRun(task,node)');
    expect(workspace).toContain("source:'HII approved board task'");
    expect(workspace).toContain('boardTaskId');
    expect(workspace).toContain('boardRunSyncKey');
    expect(workspace).toContain('boardPatchForRunState');
    expect(boardRun).toContain("patch.lane = 'doing'");
    expect(boardRun).toContain("patch.lane = 'done'");
    expect(boardRun).toContain('patch.receiptRef = receiptRef');
    expect(workspace).toContain('Run already prepared');
    expect(workspace).toContain('Prepare fresh retry');
    expect(workspace).toContain("!['failed','cancelled'].includes(String(node.payload.status");
    expect(packageJson).toContain('hii:board-run:check');
  });

  it('returns receipt-listed artifacts as editable, provenance-preserving HII objects', () => {
    expect(workspace).toContain("adapter:'run-artifact'");
    expect(workspace).toContain('<RunArtifactPane');
    expect(workspaceArtifacts).toContain('The file is not named in this run receipt.');
    expect(workspaceArtifacts).toContain('outside the approved workspace boundary');
    expect(workspaceArtifacts).toContain('The artifact changed since it was opened.');
    expect(workspaceArtifacts).toContain("'workspace.artifact.edited'");
    expect(workspaceArtifactRoute).toContain('localTerminalAllowed');
    expect(workspaceArtifactRoute).toContain('saveWorkspaceRunArtifact');
    expect(apiBridge).toContain('/^workspace\\/artifacts$/');
    expect(runArtifactPane).toContain('Save edit');
    expect(runArtifactPane).toContain('human edit receipt');
    expect(runArtifactPane).toContain("method: 'PATCH'");
  });

  it('previews receipt-linked image artifacts inside the governed result object', () => {
    expect(workspaceArtifacts).toContain('readWorkspaceRunArtifactPreview');
    expect(workspaceArtifacts).toContain('Receipt image previews are limited to 25 MB.');
    expect(workspaceArtifactRoute).toContain("params.get('mode') === 'preview'");
    expect(runArtifactPane).toContain('artifact?.previewable');
    expect(runArtifactPane).toContain('mode=preview');
  });

  it('keeps receipt-linked HTML preview visual, editable, and network blocked', () => {
    expect(workspaceArtifacts).toContain('readWorkspaceRunArtifactSitePreview');
    expect(workspaceArtifactRoute).toContain("params.get('mode') === 'site'");
    expect(workspaceArtifactRoute).toContain("sandbox; default-src 'none'");
    expect(runArtifactPane).toContain("view: 'preview' | 'edit'");
    expect(runArtifactPane).toContain('sandbox=""');
    expect(runArtifactPane).toContain('mode=site');
  });

  it('opens the combined browser and terminal explorer on workspace double-click', () => {
    expect(workspace).toContain('on:dblclick={openExplorer}');
    expect(workspace).toContain("seedFor('explorer')");
    expect(explorer).toContain('<BrowserPane');
    expect(explorer).toContain('<TerminalPane');
  });

  it('supports natural trackpad pan and cursor-anchored zoom', () => {
    expect(workspace).toContain('on:wheel={trackpad}');
    expect(workspace).toContain('canNestedSurfaceScroll');
    expect(workspace).toContain('panWorkspaceViewport');
    expect(workspace).toContain('zoomWorkspaceViewportAt');
  });

  it('keeps large spatial workspaces recoverable and navigable', () => {
    expect(workspace).toContain('countWorkspaceNodesInViewport');
    expect(workspace).toContain('Your workspace is outside this view.');
    expect(workspace).toContain('Show my work');
    expect(workspace).toContain('<WorkspaceNavigator');
    expect(workspaceNavigator).toContain('Workspace outline');
    expect(workspaceNavigator).toContain('Find an intent, run, receipt, or object');
    expect(workspace).toContain('workspaceScenes(doc.nodes)');
    expect(workspace).toContain('onOpenScene={openScene}');
    expect(workspaceNavigator).toContain('onAdjacentScene(1)');
    expect(workspace).toContain('captureScene(node.id)');
    expect(workspace).toContain('Scene name');
    expect(workspace).toContain('findOpenWorkspacePosition');
    expect(workspace).toContain('function focusNode(node:WorkspaceNode){select(node);');
  });

  it('organizes large image imports into proof-linked contact sheets', () => {
    expect(workspace).toContain('seedsFromFiles(files)');
    expect(workspace).toContain('seedsFromDataTransfer(event.dataTransfer)');
    expect(readFileSync(resolve(root, 'lib/workspace/ingest.ts'), 'utf8')).toContain("adapter: 'contact-sheet'");
    expect(readFileSync(resolve(root, 'lib/workspace/ingest.ts'), 'utf8')).toContain("crypto.subtle.digest('SHA-256'");
    const staticNode = readFileSync(resolve(root, 'src/lib/components/workspace/StaticNode.svelte'), 'utf8');
    expect(staticNode).toContain('exact duplicate');
    expect(staticNode).toContain('aspect-video w-full bg-neutral-100 object-contain');
  });

  it('turns exact contact-sheet thumbnail choices into governed run context', () => {
    expect(workspace).toContain('contactSheetContextItems');
    expect(workspace).toContain('contextNodes.flatMap(contextItemsForNode)');
    const staticNode = readFileSync(resolve(root, 'src/lib/components/workspace/StaticNode.svelte'), 'utf8');
    expect(staticNode).toContain('selected for context');
    expect(staticNode).toContain('optional focus label');
    expect(staticNode).toContain('Filter contact sheet');
    expect(staticNode).toContain('Label selected');
    expect(staticNode).toContain('labelContactSheetItems');
    expect(workspace).toContain('itemLabels:node.payload.itemLabels');
  });

  it('promotes a chosen sheet item into the existing image-region workflow', () => {
    expect(workspace).toContain('contactSheetItemSeed');
    expect(workspace).toContain('promoteContactSheetItem');
    expect(readFileSync(resolve(root, 'lib/workspace/contact-sheet.ts'), 'utf8')).toContain('sourceContactSheetId');
    expect(readFileSync(resolve(root, 'src/lib/components/workspace/StaticNode.svelte'), 'utf8')).toContain('Focus region ↗');
  });

  it('turns an exact classified review set into a provenance-linked named Scene', () => {
    const staticNode = readFileSync(resolve(root, 'src/lib/components/workspace/StaticNode.svelte'), 'utf8');
    const reviewScene = readFileSync(resolve(root, 'lib/workspace/contact-sheet-scene.ts'), 'utf8');
    expect(workspace).toContain('organizeContactSheetReviewSet');
    expect(workspace).toContain('organizeContactSheetSelection');
    expect(workspace).toContain('onOrganize={()=>organizeContactSheetSelection(node)}');
    expect(staticNode).toContain('Make Scene ↗');
    expect(reviewScene).toContain("adapter: 'contact-sheet-review-scene'");
    expect(reviewScene).toContain("membership: 'contact-sheet-selection'");
    expect(reviewScene).toContain('reviewSetSignature');
  });

  it('keeps related contact-sheet references compact without losing exact membership', () => {
    const staticNode = readFileSync(resolve(root, 'src/lib/components/workspace/StaticNode.svelte'), 'utf8');
    const contactSheet = readFileSync(resolve(root, 'lib/workspace/contact-sheet.ts'), 'utf8');
    expect(staticNode).toContain('Stack selected');
    expect(staticNode).toContain('Use stack');
    expect(staticNode).toContain('Unstack');
    expect(staticNode).toContain('Open ${stack.title} stack');
    expect(contactSheet).toContain('stackContactSheetSelection');
    expect(contactSheet).toContain('normalizeContactSheetStacks');
    expect(contactSheet).toContain('sha256s.length<2');
  });

  it('bridges an explicit browser request into its paired terminal', () => {
    expect(explorer).toContain('curl -I -L --max-time 20 --');
    expect(explorer).toContain("new CustomEvent('hii:terminal-command'");
    expect(terminal).toContain("window.addEventListener('hii:terminal-command'");
  });

  it('registers a portable cursor-bar shortcut in the Tauri shell', () => {
    expect(cargo).toContain('tauri-plugin-global-shortcut');
    expect(desktop).toContain('Modifiers::SUPER | Modifiers::SHIFT');
    expect(desktop).toContain('Modifiers::CONTROL | Modifiers::SHIFT');
    expect(desktop).toContain('"super+shift+space"');
    expect(desktop).toContain('"ctrl+shift+space"');
    expect(desktop).toContain('show_cursor_bar(app)');
    expect(desktop).toContain('app.cursor_position()');
  });

  it('keeps cursor intent inside the shared HII runner', () => {
    expect(desktop).toContain('fn run_cursor_intent');
    expect(desktop).toContain('.arg("run")');
    expect(desktop).toContain('.join("cursor-bar")');
    expect(cursorBar).toContain("invoke<string>('run_cursor_intent'");
    expect(cursorBar).toContain("invoke('hide_cursor_bar')");
    expect(cursorBar).toContain('What do you want to happen?');
  });

  it('starts the baked HII runtime in production instead of attaching to stale UI', () => {
    expect(desktop).toContain('#[cfg(dev)]');
    expect(desktop).toContain('#[cfg(not(dev))]');
    expect(desktop).toMatch(
      /#\[cfg\(not\(dev\)\)\][\s\S]*available_port\(\)\?[\s\S]*spawn_hii_server\(app, port\)/
    );
  });

  it('seals and strictly verifies the packaged macOS app', () => {
    expect(packageJson).toContain('node scripts/hii-tauri-build.mjs');
    expect(desktopBuild).toContain("'codesign'");
    expect(desktopBuild).toContain("'--strict'");
    expect(packageJson).toContain('install:tauri');
    expect(desktopInstall).toContain("'/Applications/HII.app'");
    expect(desktopInstall).toContain("'.Trash'");
    expect(desktopInstall).toContain("'--strict'");
  });

  it('keeps public Mac releases behind Developer ID and notarization proof', () => {
    expect(packageJson).toContain('release:mac');
    expect(desktopRelease).toContain('HII_SIGNING_IDENTITY');
    expect(desktopRelease).toContain('HII_NOTARY_PROFILE');
    expect(desktopRelease).toContain("'notarytool'");
    expect(desktopRelease).toContain("'stapler'");
    expect(desktopRelease).toContain("'spctl'");
    expect(desktopRelease).toContain('sha256');
    expect(desktopRelease).toContain("'latest.json'");
  });
});
