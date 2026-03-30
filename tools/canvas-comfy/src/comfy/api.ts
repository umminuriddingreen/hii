const BASE = '/comfy'
const clientId = crypto.randomUUID()

export type OnComfyMessage = (msg: {
  type: string
  data: Record<string, unknown>
}) => void

export function connectWs(onMsg: OnComfyMessage): WebSocket {
  const ws = new WebSocket(
    `ws://${location.hostname}:${location.port}/comfy/ws?clientId=${clientId}`
  )
  ws.onmessage = (e) => {
    try { onMsg(JSON.parse(e.data)) } catch {}
  }
  ws.onclose = () => setTimeout(() => connectWs(onMsg), 2000)
  return ws
}

export async function queuePrompt(workflow: Record<string, unknown>) {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  })
  return res.json() as Promise<{ prompt_id: string }>
}

export async function uploadImage(file: File) {
  const form = new FormData()
  form.append('image', file, file.name)
  form.append('overwrite', 'true')
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })
  return res.json() as Promise<{ name: string }>
}

export function viewUrl(filename: string, subfolder = '', type = 'output') {
  return `${BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
}

export async function getCheckpoints(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}/object_info/CheckpointLoaderSimple`)
    const d = await res.json()
    return d?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
  } catch { return [] }
}
