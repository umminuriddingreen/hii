import { create } from 'zustand'
import type { CanvasNode, Vec2 } from './types'

interface CanvasState {
  nodes: CanvasNode[]
  camera: { x: number; y: number; zoom: number }
  selectedIds: Set<string>

  addNode: (node: CanvasNode) => void
  updateNode: (id: string, patch: Partial<CanvasNode>) => void
  removeNode: (id: string) => void
  select: (id: string, multi?: boolean) => void
  clearSelection: () => void
  moveSelected: (dx: number, dy: number) => void
  pan: (dx: number, dy: number) => void
  zoomAt: (point: Vec2, delta: number) => void
  getSelected: () => CanvasNode[]
  getContextText: () => string
  getContextImages: () => string[]
}

let nextId = 0
export const makeId = () => `node_${++nextId}_${Date.now()}`

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  camera: { x: 0, y: 0, zoom: 1 },
  selectedIds: new Set(),

  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),

  updateNode: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),

  removeNode: (id) => set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id) })),

  select: (id, multi) =>
    set((s) => {
      const next = new Set(multi ? s.selectedIds : [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return {
        selectedIds: next,
        nodes: s.nodes.map((n) => ({ ...n, selected: next.has(n.id) })),
      }
    }),

  clearSelection: () =>
    set((s) => ({
      selectedIds: new Set(),
      nodes: s.nodes.map((n) => ({ ...n, selected: false })),
    })),

  moveSelected: (dx, dy) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        s.selectedIds.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n
      ),
    })),

  pan: (dx, dy) =>
    set((s) => ({ camera: { ...s.camera, x: s.camera.x + dx, y: s.camera.y + dy } })),

  zoomAt: (point, delta) =>
    set((s) => {
      const factor = delta > 0 ? 0.9 : 1.1
      const newZoom = Math.min(5, Math.max(0.1, s.camera.zoom * factor))
      const ratio = newZoom / s.camera.zoom
      return {
        camera: {
          x: point.x - (point.x - s.camera.x) * ratio,
          y: point.y - (point.y - s.camera.y) * ratio,
          zoom: newZoom,
        },
      }
    }),

  getSelected: () => {
    const s = get()
    return s.nodes.filter((n) => s.selectedIds.has(n.id))
  },

  getContextText: () => {
    return get()
      .getSelected()
      .filter((n) => n.type === 'text')
      .map((n) => (n.data as any).text)
      .join(', ')
  },

  getContextImages: () => {
    return get()
      .getSelected()
      .filter((n) => n.type === 'image')
      .map((n) => (n.data as any).src)
  },
}))
