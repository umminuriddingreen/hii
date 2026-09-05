export type MessagePart = { type: 'text' | 'reasoning'; text: string };
export interface Message { id: string; conversation_id: string; parent_id: string | null; role: 'user' | 'assistant' | 'system'; parts: MessagePart[]; created_at: number }
export interface Conversation { id: string; title: string; active_leaf_id: string | null; revision: number; updated_at: number }
export interface Generation { id: string; conversation_id: string; message_id: string; status: 'streaming' | 'completed' | 'cancelled' | 'failed' | 'interrupted'; model: string; endpoint: string; error: string | null; finish_reason: string | null }
export interface Snapshot { conversation: Conversation; messages: Message[]; generations: Generation[]; branch: string[] }
export interface Settings { endpoint: string; model: string; max_tokens: number; managed: boolean; executable: string; model_path: string; context_size: number }
export interface RuntimeStatus { state: string; owned: boolean; models: { id: string }[]; error: string | null }
