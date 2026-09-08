import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Conversation, Generation, RuntimeStatus, Settings, Snapshot } from './chat-types';

export const chatApi = {
  list: () => invoke<Conversation[]>('chat_conversation_list'),
  create: () => invoke<Snapshot>('chat_conversation_create'),
  get: (id: string) => invoke<Snapshot>('chat_conversation_get', { id }),
  send: (id: string, parent: string | null, text: string) => invoke<Generation>('chat_message_send', { request: { conversation_id: id, parent_id: parent, parts: [{ type: 'text', text }] } }),
  selectBranch: (id: string, leaf: string) => invoke<Snapshot>('chat_conversation_select_branch', { id, leaf }),
  stop: (id: string) => invoke<void>('chat_generation_stop', { id }),
  settings: () => invoke<Settings>('chat_settings_get'),
  saveSettings: (settings: Settings) => invoke<void>('chat_settings_set', { settings }),
  runtime: () => invoke<RuntimeStatus>('chat_runtime_status'),
  startRuntime: () => invoke<void>('chat_runtime_start'),
  stopRuntime: () => invoke<void>('chat_runtime_stop'),
  subscribe: async (handler: (snapshot: Snapshot) => void, onError: (error: string) => void) => {
    const stopErrors = await listen<{ error: string }>('hii://chat-error', event => onError(event.payload.error));
    try {
      const stopUpdates = await listen<Snapshot>('hii://chat-updated', event => handler(event.payload));
      return () => { stopErrors(); stopUpdates(); };
    } catch (error) { stopErrors(); throw error; }
  },
};
