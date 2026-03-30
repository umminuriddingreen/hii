export type HiiEventType =
  | 'intent.received'
  | 'intent.classified'
  | 'memory.loaded'
  | 'grounding.started'
  | 'grounding.finished'
  | 'tool.selected'
  | 'tool.started'
  | 'tool.finished'
  | 'response.completed'
  | 'blocker.detected';

export type HiiEvent = {
  id: string;
  type: HiiEventType;
  at: string;
  data: Record<string, unknown>;
};

let eventCounter = 0;

export function createEvent(type: HiiEventType, data: Record<string, unknown> = {}): HiiEvent {
  eventCounter += 1;
  return {
    id: `evt_${eventCounter}`,
    type,
    at: new Date().toISOString(),
    data,
  };
}
