<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
  import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
  import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
  import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import type { WorkspaceNode } from '@/lib/workspace/types';

  export let node: WorkspaceNode;

  let host: HTMLDivElement;
  let status: 'loading' | 'ready' | 'failed' = 'loading';
  let error = '';
  let progress = 0;
  let triangles = 0;
  let meshes = 0;
  let wireframe = false;
  let gridVisible = true;
  let root: THREE.Object3D | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let grid: THREE.GridHelper | null = null;
  let frameModel: (() => void) | null = null;

  $: url = String(node.payload.url || '');
  $: name = String(node.payload.name || '3D model');
  $: extension = String(node.payload.extension || '').toLowerCase();
  $: checksum = String(node.payload.sha256 || '');

  function readableError(reason: unknown) {
    if (reason instanceof Error && reason.message) return reason.message;
    if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message);
    return 'HII could not decode this model.';
  }

  function modelMaterials(object: THREE.Object3D, visit: (material: THREE.Material) => void) {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(visit);
    });
  }

  function toggleWireframe() {
    wireframe = !wireframe;
    if (!root) return;
    modelMaterials(root, (material) => {
      if ('wireframe' in material) {
        (material as THREE.MeshBasicMaterial).wireframe = wireframe;
        material.needsUpdate = true;
      }
    });
  }

  function toggleGrid() {
    gridVisible = !gridVisible;
    if (grid) grid.visible = gridVisible;
  }

  onMount(() => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f3f1ec');

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = 'block h-full w-full';
    host.appendChild(renderer.domElement);

    camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10000);
    camera.position.set(4, 3, 5);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x4d5566, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, 7, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd5ff, 1.4);
    fill.position.set(-5, 2, -4);
    scene.add(fill);

    grid = new THREE.GridHelper(10, 20, 0xa8a6a0, 0xd8d5ce);
    grid.material.transparent = true;
    grid.material.opacity = 0.48;
    scene.add(grid);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      if (camera) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    frameModel = () => {
      if (!root || !camera || !controls) return;
      const bounds = new THREE.Box3().setFromObject(root);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      root.position.sub(center);
      const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
      const distance = (maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.45;
      camera.near = Math.max(distance / 1000, 0.001);
      camera.far = Math.max(distance * 1000, 100);
      camera.position.set(distance * 0.82, distance * 0.62, distance);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
      grid!.scale.setScalar(Math.max(maxDimension / 10, 0.1));
      grid!.position.y = -size.y / 2;
    };

    const accept = (object: THREE.Object3D) => {
      root = object;
      triangles = 0;
      meshes = 0;
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        meshes += 1;
        const geometry = child.geometry;
        triangles += Math.floor((geometry.index?.count || geometry.getAttribute('position')?.count || 0) / 3);
        child.castShadow = false;
        child.receiveShadow = false;
      });
      scene.add(object);
      frameModel?.();
      status = 'ready';
      progress = 100;
    };

    const updateProgress = (event: ProgressEvent<EventTarget>) => {
      if (event.lengthComputable && event.total > 0) progress = Math.round((event.loaded / event.total) * 100);
    };
    const reject = (reason: unknown) => {
      status = 'failed';
      error = readableError(reason);
    };

    if (!url) {
      reject(new Error('The local model URL is missing.'));
    } else if (extension === 'glb' || extension === 'gltf') {
      new GLTFLoader().load(url, (asset) => accept(asset.scene), updateProgress, reject);
    } else if (extension === 'obj') {
      new OBJLoader().load(url, accept, updateProgress, reject);
    } else if (extension === 'stl') {
      new STLLoader().load(
        url,
        (geometry) => {
          geometry.computeVertexNormals();
          accept(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc8ced8, roughness: 0.72, metalness: 0.08 })));
        },
        updateProgress,
        reject
      );
    } else if (extension === 'ply') {
      new PLYLoader().load(
        url,
        (geometry) => {
          geometry.computeVertexNormals();
          const hasVertexColors = Boolean(geometry.getAttribute('color'));
          accept(
            new THREE.Mesh(
              geometry,
              new THREE.MeshStandardMaterial({
                color: hasVertexColors ? 0xffffff : 0xc8ced8,
                vertexColors: hasVertexColors,
                roughness: 0.72,
                metalness: 0.08
              })
            )
          );
        },
        updateProgress,
        reject
      );
    } else {
      reject(new Error(`${extension.toUpperCase() || 'This'} format is recognized but not renderable yet.`));
    }

    let animationFrame = 0;
    let visible = true;
    const visibilityObserver = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    });
    visibilityObserver.observe(host);
    const render = () => {
      animationFrame = requestAnimationFrame(render);
      if (!visible) return;
      controls?.update();
      renderer.render(scene, camera!);
    };
    render();

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      visibilityObserver.disconnect();
      controls?.dispose();
      if (root) {
        root.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.geometry.dispose();
        });
        modelMaterials(root, (material) => {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          material.dispose();
        });
      }
      grid?.geometry.dispose();
      if (grid && Array.isArray(grid.material)) grid.material.forEach((material) => material.dispose());
      else grid?.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  });
</script>

<div class="relative h-full min-h-0 overflow-hidden bg-[#f3f1ec]">
  <div bind:this={host} class="absolute inset-0" role="img" aria-label={`Interactive 3D viewer for ${name}`}></div>

  <div class="pointer-events-none absolute left-3 top-3 flex max-w-[70%] items-center gap-2 rounded-full border border-black/10 bg-white/90 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-neutral-600 shadow-sm backdrop-blur">
    <span class="h-1.5 w-1.5 rounded-full" class:bg-emerald-500={status === 'ready'} class:bg-amber-400={status === 'loading'} class:bg-red-500={status === 'failed'}></span>
    <span class="truncate">{extension || 'model'} · {status === 'loading' ? `${progress || '…'}%` : status}</span>
    {#if status === 'ready'}<span class="text-neutral-400">{meshes} mesh · {triangles.toLocaleString()} tri</span>{/if}
  </div>

  <div class="absolute right-3 top-3 flex gap-1 rounded-full border border-black/10 bg-white/90 p-1 shadow-sm backdrop-blur">
    <button class="rounded-full px-2.5 py-1 font-mono text-[9px] hover:bg-neutral-100" on:click={() => frameModel?.()} disabled={status !== 'ready'}>frame</button>
    <button class="rounded-full px-2.5 py-1 font-mono text-[9px] hover:bg-neutral-100" class:bg-neutral-950={wireframe} class:text-white={wireframe} on:click={toggleWireframe} disabled={status !== 'ready'}>wire</button>
    <button class="rounded-full px-2.5 py-1 font-mono text-[9px] hover:bg-neutral-100" class:bg-neutral-950={!gridVisible} class:text-white={!gridVisible} on:click={toggleGrid}>grid</button>
  </div>

  {#if status === 'failed'}
    <div class="absolute inset-0 grid place-items-center bg-[#f3f1ec]/95 p-8 text-center">
      <div class="max-w-sm">
        <p class="font-mono text-[10px] uppercase tracking-[0.14em] text-red-600">viewer could not open asset</p>
        <p class="mt-3 text-sm text-neutral-700">{error}</p>
        <p class="mt-2 text-[11px] text-neutral-400">HII currently renders self-contained GLB, GLTF, OBJ, STL, and PLY models.</p>
      </div>
    </div>
  {/if}

  <footer class="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3 rounded-full border border-black/10 bg-white/90 px-3 py-1.5 font-mono text-[9px] text-neutral-500 shadow-sm backdrop-blur">
    <span class="truncate">local source · {name}</span>
    <span class="hidden shrink-0 text-neutral-400 md:inline">drag to orbit · right drag to pan · scroll to zoom</span>
    <span class="shrink-0">{checksum ? `sha256 ${checksum.slice(0, 10)}…` : node.payload.ephemeral ? 'session only' : 'stored locally'}</span>
  </footer>
</div>
