export interface Vec2 { x: number; y: number }

export interface CanvasNode {
  id: string
  type: 'image' | 'text' | 'shape'
  x: number
  y: number
  w: number
  h: number
  selected: boolean
  data: ImageData_ | TextData_ | ShapeData_
}

export interface ImageData_ {
  src: string
  label?: string
  status?: 'loading' | 'ready' | 'generating' | 'error'
  jobId?: string
}

export interface TextData_ {
  text: string
  fontSize: number
  color: string
}

export interface ShapeData_ {
  shapeType: 'rect' | 'circle' | 'svg'
  fill: string
  stroke: string
  svgContent?: string
}
