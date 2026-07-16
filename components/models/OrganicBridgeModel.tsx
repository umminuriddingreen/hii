'use client';

import { Line, OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';

type ViewPreset = 'perspective' | 'elevation' | 'plan';
type DisplayMode = 'structure' | 'shell';

type VolumeSpec = {
  id: string;
  position: [number, number, number];
  width: number;
  height: number;
  depth: number;
  phase: number;
  ringCount: number;
  ribCount: number;
};

const REFERENCE_URL =
  '/api/workspace/assets/10077ca6-13b4-4e73-b642-f139e42810a0-Screenshot-2026-07-09-at-1.56.08-AM.png';

const VOLUMES: VolumeSpec[] = [
  { id: 'west-pavilion', position: [-5.05, 0.1, 0], width: 4.5, height: 3.2, depth: 3.75, phase: 0.2, ringCount: 10, ribCount: 24 },
  { id: 'bridge', position: [-1.25, 0.16, 0], width: 3.15, height: 1.35, depth: 2.1, phase: 1.6, ringCount: 6, ribCount: 15 },
  { id: 'east-pavilion', position: [3.35, 0.08, 0], width: 7.65, height: 3.05, depth: 3.7, phase: 2.8, ringCount: 10, ribCount: 34 }
];

const VIEW_POSITIONS: Record<ViewPreset, [number, number, number]> = {
  perspective: [12.5, 7.2, 14.5],
  elevation: [0, 0.8, 21],
  plan: [0, 22, 0.01]
};

function signedPower(value: number, exponent: number) {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

function shellPoint(spec: VolumeSpec, perimeter: number, vertical: number) {
  const roundedExponent = 0.36;
  const cap = 0.84 + 0.16 * Math.cos((vertical * Math.PI) / 2);
  const organic = 1 + 0.035 * Math.sin(perimeter * 3 + spec.phase + vertical * 2.1) + 0.018 * Math.sin(perimeter * 7 - vertical * 3.2);
  const x = (spec.width / 2) * cap * organic * signedPower(Math.cos(perimeter), roundedExponent);
  const z = (spec.depth / 2) * cap * (1 + 0.025 * Math.cos(perimeter * 5 - spec.phase)) * signedPower(Math.sin(perimeter), roundedExponent);
  const y = (spec.height / 2) * vertical + 0.07 * Math.sin(perimeter * 2 + spec.phase) * Math.cos(vertical * Math.PI * 0.7);
  return new THREE.Vector3(x, y, z);
}

function makeShellGeometry(spec: VolumeSpec) {
  const perimeterSegments = 80;
  const verticalSegments = 28;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let yIndex = 0; yIndex <= verticalSegments; yIndex += 1) {
    const vertical = -1 + (yIndex / verticalSegments) * 2;
    for (let perimeterIndex = 0; perimeterIndex < perimeterSegments; perimeterIndex += 1) {
      const perimeter = (perimeterIndex / perimeterSegments) * Math.PI * 2;
      const point = shellPoint(spec, perimeter, vertical);
      positions.push(point.x, point.y, point.z);
    }
  }

  for (let yIndex = 0; yIndex < verticalSegments; yIndex += 1) {
    for (let perimeterIndex = 0; perimeterIndex < perimeterSegments; perimeterIndex += 1) {
      const next = (perimeterIndex + 1) % perimeterSegments;
      const a = yIndex * perimeterSegments + perimeterIndex;
      const b = yIndex * perimeterSegments + next;
      const c = (yIndex + 1) * perimeterSegments + next;
      const d = (yIndex + 1) * perimeterSegments + perimeterIndex;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeCageGeometry(spec: VolumeSpec) {
  const vertices: number[] = [];
  const perimeterSegments = 96;
  const verticalSegments = 30;

  for (let ringIndex = 1; ringIndex < spec.ringCount - 1; ringIndex += 1) {
    const baseVertical = -1 + (ringIndex / (spec.ringCount - 1)) * 2;
    for (let segment = 0; segment < perimeterSegments; segment += 1) {
      const t1 = (segment / perimeterSegments) * Math.PI * 2;
      const t2 = ((segment + 1) / perimeterSegments) * Math.PI * 2;
      const wave1 = baseVertical + 0.055 * Math.sin(t1 * 3 + ringIndex * 0.8 + spec.phase);
      const wave2 = baseVertical + 0.055 * Math.sin(t2 * 3 + ringIndex * 0.8 + spec.phase);
      const a = shellPoint(spec, t1, Math.max(-1, Math.min(1, wave1)));
      const b = shellPoint(spec, t2, Math.max(-1, Math.min(1, wave2)));
      vertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  for (let ribIndex = 0; ribIndex < spec.ribCount; ribIndex += 1) {
    const perimeterBase = (ribIndex / spec.ribCount) * Math.PI * 2;
    for (let segment = 0; segment < verticalSegments; segment += 1) {
      const y1 = -1 + (segment / verticalSegments) * 2;
      const y2 = -1 + ((segment + 1) / verticalSegments) * 2;
      const t1 = perimeterBase + 0.045 * Math.sin(y1 * Math.PI * 2 + ribIndex * 0.65 + spec.phase);
      const t2 = perimeterBase + 0.045 * Math.sin(y2 * Math.PI * 2 + ribIndex * 0.65 + spec.phase);
      const a = shellPoint(spec, t1, y1);
      const b = shellPoint(spec, t2, y2);
      vertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}

function OrganicVolume({ spec, mode }: { spec: VolumeSpec; mode: DisplayMode }) {
  const shell = useMemo(() => makeShellGeometry(spec), [spec]);
  const cage = useMemo(() => makeCageGeometry(spec), [spec]);

  useEffect(() => () => {
    shell.dispose();
    cage.dispose();
  }, [cage, shell]);

  return (
    <group position={spec.position}>
      <mesh geometry={shell} castShadow receiveShadow>
        <meshPhysicalMaterial
          color={mode === 'shell' ? '#b9c7c2' : '#d8e0dc'}
          roughness={mode === 'shell' ? 0.34 : 0.72}
          metalness={mode === 'shell' ? 0.08 : 0.02}
          transparent
          opacity={mode === 'shell' ? 0.7 : 0.13}
          transmission={mode === 'shell' ? 0.12 : 0}
          side={THREE.DoubleSide}
          depthWrite={mode === 'shell'}
        />
      </mesh>
      <lineSegments geometry={cage}>
        <lineBasicMaterial color={mode === 'shell' ? '#40544f' : '#121918'} transparent opacity={mode === 'shell' ? 0.68 : 0.94} />
      </lineSegments>
    </group>
  );
}

function CameraPreset({ preset }: { preset: ViewPreset }) {
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    camera.position.set(...VIEW_POSITIONS[preset]);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, preset]);

  return null;
}

function Scene({ mode, preset, autoRotate }: { mode: DisplayMode; preset: ViewPreset; autoRotate: boolean }) {
  const outline = useMemo(
    () => [
      new THREE.Vector3(-8.2, -1.74, -2.2),
      new THREE.Vector3(7.6, -1.74, -2.2)
    ],
    []
  );

  return (
    <>
      <color attach="background" args={['#d7dcde']} />
      <fog attach="fog" args={['#d7dcde', 24, 42]} />
      <ambientLight intensity={1.45} color="#d7e4e1" />
      <hemisphereLight args={['#f5fbf8', '#7b8783', 1.15]} />
      <directionalLight position={[6, 10, 7]} intensity={2.1} color="#ffffff" castShadow shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[-8, 3, -4]} intensity={0.7} color="#b9d0cd" />

      <group position={[0, 0.55, 0]}>
        {VOLUMES.map((spec) => <OrganicVolume key={spec.id} spec={spec} mode={mode} />)}
      </group>

      <mesh position={[0, -1.25, 0]} receiveShadow>
        <boxGeometry args={[19, 0.18, 7.4]} />
        <meshStandardMaterial color="#b8bfbe" roughness={0.95} />
      </mesh>
      <gridHelper args={[28, 56, '#899291', '#bcc2c2']} position={[0, -1.15, 0]} />
      <Line points={outline} color="#5f6967" lineWidth={1} transparent opacity={0.5} />

      <CameraPreset preset={preset} />
      <OrbitControls
        makeDefault
        target={[0, 0.2, 0]}
        enableDamping
        dampingFactor={0.08}
        enablePan
        autoRotate={autoRotate}
        autoRotateSpeed={0.42}
        minDistance={8}
        maxDistance={34}
        minPolarAngle={0.02}
        maxPolarAngle={Math.PI / 2.02}
      />
    </>
  );
}

function ModelLoading() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#d7dcde] font-mono text-[10px] uppercase tracking-[0.18em] text-[#58615f]">
      constructing model…
    </div>
  );
}

export function OrganicBridgeModel() {
  const [mode, setMode] = useState<DisplayMode>('structure');
  const [preset, setPreset] = useState<ViewPreset>('perspective');
  const [showReference, setShowReference] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return (
    <main className="relative h-screen min-h-[420px] w-screen overflow-hidden bg-[#d7dcde] text-[#121817]">
      <Suspense fallback={<ModelLoading />}>
        <Canvas
          shadows
          camera={{ position: VIEW_POSITIONS.perspective, fov: 38, near: 0.1, far: 80 }}
          dpr={[1, 1.6]}
          gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        >
          <Scene mode={mode} preset={preset} autoRotate={autoRotate && !reducedMotion} />
        </Canvas>
      </Suspense>

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-5 bg-gradient-to-b from-[#d7dcde] via-[#d7dcde]/80 to-transparent p-5 pb-16">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-[#55615e]">HII · spatial model study 001</div>
          <h1 className="mt-1 text-[clamp(24px,4vw,48px)] font-medium leading-none tracking-[-0.055em]">Organic Bridge</h1>
          <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-[#596361]">
            Concept reconstruction inferred from one orthographic wireframe screenshot. Proportions and lattice language are faithful; hidden elevations and dimensions are modeled assumptions.
          </p>
        </div>
        <div className="rounded-full border border-[#2d3936]/15 bg-white/45 px-3 py-1 font-mono text-[8px] uppercase tracking-[0.16em] text-[#495451] backdrop-blur">
          interactive · local WebGL
        </div>
      </header>

      <aside className="absolute bottom-5 left-5 flex flex-col gap-2" aria-label="Model controls">
        <div className="flex flex-wrap gap-1 rounded-[14px] border border-black/10 bg-[#edf0ef]/88 p-1 shadow-[0_12px_44px_rgba(28,38,35,0.13)] backdrop-blur-xl">
          {(['structure', 'shell'] as DisplayMode[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={`rounded-[10px] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.12em] transition ${mode === value ? 'bg-[#121817] text-white' : 'text-[#58615f] hover:bg-white/70'}`}
            >
              {value}
            </button>
          ))}
          <span className="mx-0.5 w-px bg-black/10" aria-hidden="true" />
          {(['perspective', 'elevation', 'plan'] as ViewPreset[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setPreset(value)}
              aria-pressed={preset === value}
              className={`rounded-[10px] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.12em] transition ${preset === value ? 'bg-white text-[#121817] shadow-sm' : 'text-[#58615f] hover:bg-white/60'}`}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => setShowReference((value) => !value)} className="rounded-full border border-black/10 bg-[#edf0ef]/88 px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-[#4d5855] shadow-sm backdrop-blur hover:bg-white">
            {showReference ? 'hide source' : 'show source'}
          </button>
          <button type="button" onClick={() => setAutoRotate((value) => !value)} className="rounded-full border border-black/10 bg-[#edf0ef]/88 px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.14em] text-[#4d5855] shadow-sm backdrop-blur hover:bg-white" aria-pressed={autoRotate}>
            {autoRotate ? 'stop orbit' : 'auto orbit'}
          </button>
        </div>
      </aside>

      {showReference && (
        <figure className="absolute bottom-5 right-5 w-[min(42vw,520px)] overflow-hidden rounded-[16px] border border-black/15 bg-[#c8ced0]/95 p-2 shadow-[0_20px_60px_rgba(22,30,28,0.22)] backdrop-blur-xl">
          <img src={REFERENCE_URL} alt="Original orthographic wireframe reference" className="block aspect-[2.7/1] w-full rounded-[10px] object-cover" />
          <figcaption className="flex items-center justify-between gap-3 px-1 pb-0.5 pt-2 font-mono text-[8px] uppercase tracking-[0.13em] text-[#596260]">
            <span>source reference</span>
            <span>single view · scale unknown</span>
          </figcaption>
        </figure>
      )}

      <div className="pointer-events-none absolute bottom-5 right-5 font-mono text-[8px] uppercase tracking-[0.14em] text-[#5f6967]" aria-hidden={showReference}>
        drag to orbit · scroll to zoom · right-drag to pan
      </div>
    </main>
  );
}
