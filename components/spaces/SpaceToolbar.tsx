'use client';

export function SpaceToolbar({ drawing, onAddText, onAddSticker, onAddImage, onToggleDrawing }: {
  drawing: boolean;
  onAddText: () => void;
  onAddSticker: () => void;
  onAddImage: () => void;
  onToggleDrawing: () => void;
}) {
  return <nav className="hii-space-toolbar" data-workspace-ui aria-label="Space tools" onPointerDown={(event) => event.stopPropagation()}>
    <strong>HII Space</strong>
    <button type="button" onClick={onAddImage}>Photo</button>
    <button type="button" onClick={onAddText}>Text</button>
    <button type="button" onClick={onAddSticker}>Sticker</button>
    <button type="button" aria-pressed={drawing} onClick={onToggleDrawing}>{drawing ? 'Drawing...' : 'Draw'}</button>
  </nav>;
}
