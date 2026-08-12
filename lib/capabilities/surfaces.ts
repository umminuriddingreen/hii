import type { CapabilityDefinition, CapabilityStatus } from './types';

export type CapabilitySurface = {
  href: string;
  id: string;
  label: string;
};

export const capabilitySurfaces: Record<string, CapabilitySurface> = {
  'hii.terminal.observe': { href: '/console', id: 'console', label: 'Console' },
  'hii.agent.spawn': { href: '/console', id: 'console', label: 'Console' },
  'hii.agent.workspace_run': { href: '/workspace', id: 'desk', label: 'Desk' },
  'hii.og.operational_graph': { href: '/workspace', id: 'desk', label: 'Desk' },
  'hii.loop.user_proxy': { href: '/notch', id: 'notch', label: 'Notch' },
  'hii.daemon.instances': { href: '/console', id: 'console', label: 'Console' },
  'hii.space.desktop_control': { href: '/workspace', id: 'desk', label: 'Desk' },
  'hii.board.task_kanban': { href: '/boards', id: 'boards', label: 'Boards' },
  'hii.money.idea_to_offer': { href: '/create', id: 'create', label: 'Create' },
  'hii.pack.export': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.skills.grow': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.registry.scan': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.registry.doctor': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.credits.quote': { href: '/create', id: 'create', label: 'Create' },
  'termite.rhino.managed_job': { href: '/create', id: 'create', label: 'Create' },
  'termite.rhino.installer_action': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.browser.link_capture': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.downloader.offline_cache': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.ollama.link_interpreter': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.exchange.asset_link': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.links.publish_stream': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.exchange.link_stream_mcp': { href: '/browser', id: 'browser', label: 'Browser' },
  'thirdparty.blender_mcp': { href: '/activate', id: 'activate', label: 'Activate' },
  'thirdparty.browsermcp': { href: '/activate', id: 'activate', label: 'Activate' },
  'thirdparty.google_mcp_catalog': { href: '/activate', id: 'activate', label: 'Activate' },
  'thirdparty.searxng_search_mcp': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.workspace.creative_canvas': { href: '/workspace', id: 'desk', label: 'Desk' },
  'hii.scene.sound-field': { href: '/workspace', id: 'desk', label: 'Desk' },
  'hii.knowledge.workspace': { href: '/knowledge', id: 'knowledge', label: 'Knowledge' },
  'hii.window-state.backend': { href: '/workspace', id: 'desk', label: 'Desk' },
  'hii.config.read': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.config.control': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.skills.start': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.skills.conversation_draft': { href: '/activate', id: 'activate', label: 'Activate' },
  'hii.schedule.local_cron': { href: '/boards', id: 'boards', label: 'Boards' },
  'hii.calendar.apple': { href: '/boards', id: 'boards', label: 'Boards' },
  'hii.system.monitor': { href: '/console', id: 'console', label: 'Console' },
  'hii.notch.ambient': { href: '/notch', id: 'notch', label: 'Notch' },
  'hii.voice.interpret': { href: '/notch', id: 'notch', label: 'Notch' },
  'hii.browser.retrieval': { href: '/browser', id: 'browser', label: 'Browser' },
  'hii.create.workflow': { href: '/create', id: 'create', label: 'Create' }
};

export function surfaceForCapability(id: string): CapabilitySurface | null {
  return capabilitySurfaces[id] ?? null;
}

export function surfaceStatus(
  capabilities: Pick<CapabilityDefinition, 'id' | 'status'>[],
  surfaceId: string
): CapabilityStatus | 'unknown' {
  const statuses = capabilities
    .filter((capability) => capabilitySurfaces[capability.id]?.id === surfaceId)
    .map((capability) => capability.status);
  if (!statuses.length) return 'unknown';
  if (statuses.every((status) => status === 'ready')) return 'ready';
  if (statuses.some((status) => status === 'ready' || status === 'partial')) return 'partial';
  if (statuses.every((status) => status === 'blocked')) return 'blocked';
  return 'planned';
}
