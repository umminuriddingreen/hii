import { useRef, useCallback, useState } from 'react'
import { useCanvasStore, makeId } from './store'
import type { CanvasNode, ImageData_ } from './types'

export function InfiniteCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { nodes, camera, addNode, select, clearSelection, moveSelected, pan, zoomAt } =
    useCanvasStore()
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number } | null>(null)
  const [panning, setPanning] = useState<{ startX: number; startY: number } | null>(null)
  const [editingText, setEditingText] = useState<string | null>(null)

  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - camera.x) / camera.zoom,
      y: (sy - camera.y) / camera.zoom,
    }),
    [camera]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const files = e.dataTransfer.files
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue
        const url = URL.createObjectURL(file)
        const img = new Image()
        img.onload = () => {
          const scale = Math.min(400 / img.naturalWidth, 400 / img.naturalHeight, 1)
          const rect = containerRef.current!.getBoundingClientRect()
          const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
          addNode({
            id: makeId(), type: 'image',
            x: world.x, y: world.y,
            w: img.naturalWidth * scale, h: img.naturalHeight * scale,
            selected: false,
            data: { src: url, status: 'ready' } as ImageData_,
          })
        }
        img.src = url
      }
    },
    [addNode, screenToWorld]
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current!.getBoundingClientRect()
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
      const id = makeId()
      addNode({
        id, type: 'text',
        x: world.x, y: world.y, w: 200, h: 32,
        selected: false,
        data: { text: '', fontSize: 14, color: '#1a1a1a' },
      })
      setEditingText(id)
    },
    [addNode, screenToWorld]
  )

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        setPanning({ startX: e.clientX, startY: e.clientY })
        return
      }
      const rect = containerRef.current!.getBoundingClientRect()
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
      const hit = [...nodes].reverse().find(
        (n) => world.x >= n.x && world.x <= n.x + n.w && world.y >= n.y && world.y <= n.y + n.h
      )
      if (hit) {
        select(hit.id, e.shiftKey)
        setDragging({ id: hit.id, startX: e.clientX, startY: e.clientY })
      } else if (e.button === 0) {
        clearSelection()
      }
    },
    [nodes, screenToWorld, select, clearSelection]
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (panning) {
        pan(e.clientX - panning.startX, e.clientY - panning.startY)
        setPanning({ startX: e.clientX, startY: e.clientY })
        return
      }
      if (dragging) {
        const dx = (e.clientX - dragging.startX) / camera.zoom
        const dy = (e.clientY - dragging.startY) / camera.zoom
        moveSelected(dx, dy)
        setDragging({ ...dragging, startX: e.clientX, startY: e.clientY })
      }
    },
    [panning, dragging, camera.zoom, pan, moveSelected]
  )

  const onMouseUp = useCallback(() => {
    setPanning(null)
    setDragging(null)
  }, [])

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = containerRef.current!.getBoundingClientRect()
        zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY)
      } else {
        pan(-e.deltaX, -e.deltaY)
      }
    },
    [pan, zoomAt]
  )

  return (
    <div
      ref={containerRef}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      style={{
        width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
        cursor: panning ? 'grabbing' : 'default',
        background: '#f5f3ee',
      }}
    >
      <GridPattern camera={camera} />

      <div style={{
        position: 'absolute', left: 0, top: 0,
        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
        transformOrigin: '0 0',
      }}>
        {nodes.map((node) => (
          <NodeRenderer
            key={node.id} node={node}
            editing={editingText === node.id}
            onFinishEdit={() => setEditingText(null)}
          />
        ))}
      </div>

      <div style={{
        position: 'absolute', bottom: 14, left: 14,
        color: '#999', fontSize: 11, fontFamily: 'monospace', letterSpacing: 1,
      }}>
        {Math.round(camera.zoom * 100)}%
      </div>
    </div>
  )
}

function GridPattern({ camera }: { camera: { x: number; y: number; zoom: number } }) {
  const gap = 32 * camera.zoom
  const ox = camera.x % gap
  const oy = camera.y % gap
  return (
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <defs>
        <pattern id="grid" width={gap} height={gap} patternUnits="userSpaceOnUse" x={ox} y={oy}>
          <circle cx={gap / 2} cy={gap / 2} r={0.6} fill="#d5d0c8" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>
  )
}

/* ── Bauhaus color palette ── */
const B = {
  red: '#c1272d',
  blue: '#1b3a8c',
  yellow: '#f2b705',
  black: '#1a1a1a',
  white: '#ffffff',
  warm: '#f5f3ee',
  border: 'rgba(0,0,0,0.08)',
  selectBorder: '#1b3a8c',
  selectShadow: 'rgba(27,58,140,0.12)',
}

function NodeRenderer({
  node, editing, onFinishEdit,
}: {
  node: CanvasNode; editing: boolean; onFinishEdit: () => void
}) {
  const updateNode = useCanvasStore((s) => s.updateNode)

  if (node.type === 'image') {
    const d = node.data as ImageData_
    return (
      <div style={{
        position: 'absolute', left: node.x, top: node.y, width: node.w, height: node.h,
        borderRadius: 6, overflow: 'hidden',
        outline: node.selected ? `2px solid ${B.selectBorder}` : 'none',
        outlineOffset: 2,
        boxShadow: node.selected
          ? `0 0 0 1px ${B.selectBorder}, 0 2px 12px ${B.selectShadow}`
          : '0 1px 6px rgba(0,0,0,0.08)',
        background: B.white,
      }}>
        {d.status === 'generating' ? (
          <div style={{
            width: '100%', height: '100%',
            background: `linear-gradient(135deg, ${B.warm} 25%, #ebe7df 50%, ${B.warm} 75%)`,
            backgroundSize: '200% 200%', animation: 'shimmer 2s ease infinite',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: B.blue, fontSize: 13, fontWeight: 500, letterSpacing: 0.5,
          }}>
            Generating...
          </div>
        ) : (
          <img
            src={d.src}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
        {d.label && (
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)',
            color: B.black, fontSize: 10, fontWeight: 500,
            padding: '4px 8px', letterSpacing: 0.3,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {d.label}
          </div>
        )}
      </div>
    )
  }

  if (node.type === 'text') {
    const d = node.data as { text: string; fontSize: number; color: string }
    return (
      <div style={{
        position: 'absolute', left: node.x, top: node.y,
        minWidth: 40, minHeight: 20,
        outline: node.selected ? `1.5px solid ${B.selectBorder}` : 'none',
        outlineOffset: 3,
        borderRadius: 4,
        padding: '4px 8px',
        background: node.selected ? 'rgba(27,58,140,0.04)' : 'transparent',
      }}>
        {editing ? (
          <textarea
            autoFocus
            defaultValue={d.text}
            onBlur={(e) => {
              updateNode(node.id, {
                data: { ...d, text: e.target.value },
                w: Math.max(120, e.target.scrollWidth + 16),
                h: Math.max(28, e.target.scrollHeight + 8),
              })
              onFinishEdit()
            }}
            onKeyDown={(e) => { if (e.key === 'Escape') onFinishEdit() }}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: B.black, fontSize: d.fontSize, fontFamily: 'inherit',
              resize: 'both', minWidth: 120, minHeight: 24,
            }}
          />
        ) : (
          <div style={{
            color: B.black, fontSize: d.fontSize,
            whiteSpace: 'pre-wrap', userSelect: 'none',
            opacity: d.text ? 1 : 0.35,
          }}>
            {d.text || 'Double-click to type'}
          </div>
        )}
      </div>
    )
  }

  return null
}
