export type WorkspaceRunContextReference = {
  id?: string;
  title?: string;
  type?: string;
  source?: string;
};

const secretFilePattern =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.netrc|\.npmrc|\.pypirc|credentials(?:\.[^/]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]+)?)$/i;
const secretQueryPattern =
  /[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)=/i;

export function sensitiveWorkspaceContextSource(source: unknown) {
  const normalized = String(source || '').trim().replaceAll('\\', '/');
  return Boolean(normalized && (secretFilePattern.test(normalized) || secretQueryPattern.test(normalized)));
}

export function assertWorkspaceRunContextSafe(context: WorkspaceRunContextReference[]) {
  if (context.some((item) => sensitiveWorkspaceContextSource(item.source))) {
    throw new Error(
      'Secret-like files and credential-bearing URLs cannot be attached to a workspace run.'
    );
  }
}

export function workspaceRunBoundaryManifest(input: {
  context?: WorkspaceRunContextReference[];
  workspaceRoot?: unknown;
}) {
  const context = Array.isArray(input.context) ? input.context : [];
  const workspaceRoot = String(input.workspaceRoot || '').trim();
  const provenanceCount = context.filter((item) => String(item.source || '').trim()).length;
  const missingProvenanceCount = Math.max(0, context.length - provenanceCount);
  const sensitiveCount = context.filter((item) =>
    sensitiveWorkspaceContextSource(item.source)
  ).length;

  return {
    contextCount: context.length,
    provenanceCount,
    missingProvenanceCount,
    sensitiveCount,
    blocked: sensitiveCount > 0 || !workspaceRoot,
    readScope: !workspaceRoot
      ? 'Choose a specific project folder before HII can resolve the run boundary.'
      : context.length
      ? `${context.length} selected canvas object${context.length === 1 ? '' : 's'} ${context.length === 1 ? 'guides' : 'guide'} the run. AII may inspect other non-secret files inside ${workspaceRoot} when the intent requires them.`
      : `No canvas object is attached. AII may inspect non-secret files inside ${workspaceRoot} when the intent requires them.`,
    writeScope: workspaceRoot || 'No project folder selected',
    externalScope: 'No publish, push, message, spend, upload, or secret export',
    secretPolicy: 'Secret files and credential values remain blocked even inside the workspace boundary.'
  };
}
