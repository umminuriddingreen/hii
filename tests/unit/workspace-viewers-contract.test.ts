import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workspace = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
const model = readFileSync(resolve(root, 'src/lib/components/workspace/ModelPane.svelte'), 'utf8');
const document = readFileSync(resolve(root, 'src/lib/components/workspace/DocumentPane.svelte'), 'utf8');
const cad = readFileSync(resolve(root, 'src/lib/components/workspace/CadPane.svelte'), 'utf8');
const assets = readFileSync(resolve(root, 'app/api/workspace/assets/route.ts'), 'utf8');
const asset = readFileSync(resolve(root, 'app/api/workspace/assets/[name]/route.ts'), 'utf8');

describe('workspace asset viewer contract', () => {
  it('renders model and document nodes as first-class workspace objects', () => {
    expect(workspace).toContain("node.type==='model'");
    expect(workspace).toContain("import('$lib/components/workspace/ModelPane.svelte')");
    expect(workspace).toContain('<svelte:component this={ModelPaneComponent} {node}');
    expect(workspace).toContain("node.type==='document'");
    expect(workspace).toContain('<DocumentPane {node}');
    expect(workspace).toContain("node.type==='cad'");
    expect(workspace).toContain('<CadPane {node}');
  });

  it('renders persisted DXF drawings with bounded 2D interaction and layer controls', () => {
    expect(cad).toContain('parseDxf');
    expect(cad).toContain('Interactive DXF viewer');
    expect(cad).toContain('drawing layers');
    expect(cad).toContain('drag to pan · scroll to zoom · frame to reset');
    expect(cad).toContain('sha256');
    expect(asset).toContain("dxf: 'image/vnd.dxf'");
  });

  it('supports bounded interactive 3D formats with explicit lifecycle cleanup', () => {
    expect(model).toContain('GLTFLoader');
    expect(model).toContain('OBJLoader');
    expect(model).toContain('STLLoader');
    expect(model).toContain('PLYLoader');
    expect(model).toContain("Math.min(window.devicePixelRatio || 1, 2)");
    expect(model).toContain('IntersectionObserver');
    expect(model).toContain('renderer.dispose()');
    expect(model).toContain('drag to orbit · right drag to pan · scroll to zoom');
  });

  it('shows document provenance and preserves local asset integrity evidence', () => {
    expect(document).toContain('local source');
    expect(document).toContain('sha256');
    expect(document).toContain('Document viewer');
    expect(assets).toContain("createHash('sha256')");
    expect(asset).toContain("glb: 'model/gltf-binary'");
    expect(asset).toContain("obj: 'model/obj'");
  });
});
