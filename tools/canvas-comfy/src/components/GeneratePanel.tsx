import { useState, useEffect, useRef } from 'react'
import { useCanvasStore, makeId } from '../canvas/store'
import { queuePrompt, connectWs, viewUrl, uploadImage, getCheckpoints, captureRhinoViewport } from '../comfy/api'
import { txt2img, img2img } from '../comfy/workflows'
import type { ImageData_ } from '../canvas/types'

const B = {
  blue: '#1b3a8c',
  red: '#c1272d',
  yellow: '#f2b705',
  black: '#1a1a1a',
  glass: 'rgba(255,255,255,0.72)',
  glassBorder: 'rgba(0,0,0,0.06)',
  inputBg: 'rgba(0,0,0,0.03)',
  inputBorder: 'rgba(0,0,0,0.08)',
}

export function GeneratePanel() {
  const { addNode, updateNode, getContextText, getContextImages, camera } = useCanvasStore()
  const [prompt, setPrompt] = useState('')
  const [neg, setNeg] = useState('')
  const [mode, setMode] = useState<'txt2img' | 'img2img'>('txt2img')
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [denoise, setDenoise] = useState(0.6)
  const [connected, setConnected] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const pendingNodeRef = useRef<string | null>(null)

  useEffect(() => {
    getCheckpoints().then((m) => {
      setModels(m)
      if (m.length) setModel(m[0])
      setConnected(m.length > 0)
    })
  }, [])

  useEffect(() => {
    const ws = connectWs((msg) => {
      setConnected(true)
      if (msg.type === 'progress') {
        const d = msg.data as { value: number; max: number }
        setProgress(Math.round((d.value / d.max) * 100))
      }
      if (msg.type === 'executed') {
        const imgs = (msg.data as any)?.output?.images
        if (imgs?.[0] && pendingNodeRef.current) {
          const url = viewUrl(imgs[0].filename, imgs[0].subfolder, imgs[0].type)
          updateNode(pendingNodeRef.current, {
            data: { src: url, status: 'ready', label: prompt.slice(0, 60) } as ImageData_,
          })
          pendingNodeRef.current = null
          setGenerating(false)
          setProgress(0)
        }
      }
    })
    return () => ws.close()
  }, [updateNode, prompt])

  async function generate() {
    if (!prompt.trim()) return
    setGenerating(true)
    setProgress(0)

    const id = makeId()
    pendingNodeRef.current = id
    addNode({
      id, type: 'image',
      x: -camera.x / camera.zoom + 300,
      y: -camera.y / camera.zoom + 200,
      w: 512, h: 512, selected: false,
      data: { src: '', status: 'generating', label: prompt.slice(0, 60) } as ImageData_,
    })

    try {
      if (mode === 'img2img') {
        const imgs = getContextImages()
        if (imgs.length > 0) {
          const res = await fetch(imgs[0])
          const blob = await res.blob()
          const file = new File([blob], 'input.png', { type: 'image/png' })
          const uploaded = await uploadImage(file)
          await queuePrompt(img2img(prompt, uploaded.name, denoise, neg, model || undefined))
          return
        }
      }
      await queuePrompt(txt2img(prompt, neg, 1024, 1024, model || undefined))
    } catch {
      updateNode(id, { data: { src: '', status: 'error' } as ImageData_ })
      setGenerating(false)
    }
  }

  async function captureRhino() {
    setCapturing(true)
    try {
      const { url, filename } = await captureRhinoViewport()
      const id = makeId()
      addNode({
        id, type: 'image',
        x: -camera.x / camera.zoom + 60,
        y: -camera.y / camera.zoom + 200,
        w: 512, h: 288, selected: true,
        data: { src: url, status: 'ready', label: `Rhino: ${filename}` } as ImageData_,
      })
      setMode('img2img')
    } catch (e: any) {
      console.error('Rhino capture failed:', e)
    } finally {
      setCapturing(false)
    }
  }

  function pullContext() {
    const ctx = getContextText()
    if (ctx) setPrompt((p) => (p ? `${p}, ${ctx}` : ctx))
  }

  return (
    <div style={{
      position: 'absolute', right: 14, top: 14, width: 240,
      background: B.glass, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderRadius: 14, padding: 14, zIndex: 100,
      display: 'flex', flexDirection: 'column', gap: 8,
      border: `1px solid ${B.glassBorder}`,
      boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
      color: B.black, fontSize: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          Generate
        </span>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: connected ? '#2ecc71' : B.red,
        }} />
      </div>

      {/* Capture Rhino */}
      <button onClick={captureRhino} disabled={capturing} style={{
        border: `1px solid ${B.inputBorder}`, borderRadius: 8, padding: '6px 0',
        background: capturing ? B.yellow : 'transparent',
        color: capturing ? B.black : B.blue,
        cursor: capturing ? 'wait' : 'pointer',
        fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
        transition: 'all 0.15s',
      }}>
        {capturing ? 'Capturing...' : 'Capture Rhino Viewport'}
      </button>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 4, background: B.inputBg, borderRadius: 8, padding: 3 }}>
        {(['txt2img', 'img2img'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} style={{
            flex: 1, padding: '5px 0', border: 'none', borderRadius: 6,
            background: mode === m ? B.blue : 'transparent',
            color: mode === m ? '#fff' : '#888',
            cursor: 'pointer', fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
            transition: 'all 0.15s',
          }}>
            {m === 'txt2img' ? 'Text' : 'Image'}
          </button>
        ))}
      </div>

      {/* Prompt */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe..."
        rows={2}
        style={{
          background: B.inputBg, color: B.black, border: `1px solid ${B.inputBorder}`,
          borderRadius: 8, padding: '8px 10px', resize: 'none',
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1.4,
          outline: 'none',
        }}
      />

      {/* Context pull */}
      <button onClick={pullContext} style={{
        background: 'transparent', border: `1px solid ${B.inputBorder}`, borderRadius: 6,
        color: B.blue, padding: '4px 0', cursor: 'pointer',
        fontSize: 11, fontWeight: 500,
      }}>
        + Pull from selection
      </button>

      {/* Negative */}
      <textarea
        value={neg}
        onChange={(e) => setNeg(e.target.value)}
        placeholder="Negative"
        rows={1}
        style={{
          background: B.inputBg, color: B.black, border: `1px solid ${B.inputBorder}`,
          borderRadius: 8, padding: '6px 10px', resize: 'none',
          fontFamily: 'inherit', fontSize: 11, outline: 'none',
        }}
      />

      {/* Model select */}
      {models.length > 0 && (
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{
          background: B.inputBg, color: B.black, border: `1px solid ${B.inputBorder}`,
          borderRadius: 8, padding: '6px 8px', fontSize: 11, outline: 'none',
        }}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}

      {/* Denoise slider (img2img only) */}
      {mode === 'img2img' && (
        <div>
          <label style={{ fontSize: 10, color: '#999', fontWeight: 500 }}>
            Strength {denoise.toFixed(2)}
          </label>
          <input
            type="range" min={0} max={1} step={0.05}
            value={denoise} onChange={(e) => setDenoise(+e.target.value)}
            style={{ width: '100%', accentColor: B.blue }}
          />
        </div>
      )}

      {/* Generate button */}
      <button onClick={generate} disabled={generating || !prompt.trim()} style={{
        border: 'none', borderRadius: 8, padding: '8px 0',
        background: generating
          ? `linear-gradient(135deg, ${B.blue}, ${B.red})`
          : B.blue,
        color: '#fff', fontWeight: 600, fontSize: 12,
        cursor: generating ? 'wait' : 'pointer',
        letterSpacing: 0.5, textTransform: 'uppercase',
        opacity: (!prompt.trim() && !generating) ? 0.4 : 1,
        transition: 'all 0.2s',
      }}>
        {generating ? `${progress}%` : 'Generate'}
      </button>
    </div>
  )
}
