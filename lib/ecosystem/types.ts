export type HiiEcosystemMode = 'notch' | 'browser' | 'create';

export type HiiObjectRef = {
  kind: 'capture' | 'workflow' | 'run' | 'artifact' | 'receipt';
  id: string;
};

export type HiiCapture = {
  schemaVersion: 1;
  kind: 'hii.capture';
  id: string;
  projectId: string;
  url: string;
  title: string;
  selection: string;
  excerpt: string;
  source: 'hii-browser' | 'helium' | 'extension' | 'manual';
  permission: 'local-only';
  contentHash: string;
  createdAt: string;
};

export type HiiWorkflowNodeKind = 'capture' | 'prompt' | 'capability' | 'approval' | 'output';

export type HiiWorkflowNode = {
  id: string;
  kind: HiiWorkflowNodeKind;
  title: string;
  capabilityId?: string;
  config?: Record<string, unknown>;
};

export type HiiWorkflowEdge = {
  from: string;
  to: string;
};

export type HiiWorkflow = {
  schemaVersion: 1;
  kind: 'hii.workflow';
  id: string;
  projectId: string;
  title: string;
  revision: number;
  revisionHash: string;
  nodes: HiiWorkflowNode[];
  edges: HiiWorkflowEdge[];
  adapter: {
    id: 'comfyui';
    prompt: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
};

export type HiiEcosystemEventStatus =
  | 'ready'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type HiiEcosystemEvent = {
  schemaVersion: 1;
  kind: 'hii.ecosystem.event';
  id: string;
  mode: HiiEcosystemMode;
  projectId: string;
  status: HiiEcosystemEventStatus;
  summary: string;
  object?: HiiObjectRef;
  proofRefs: string[];
  createdAt: string;
};
