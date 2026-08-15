'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { WorkspaceNode } from '../../../lib/workspace/types';

type NodeBodyProps = {
  node: WorkspaceNode;
  onPayload: (patch: Record<string, unknown>) => void;
};

type SoundSite = {
  id: string;
  label: string;
  detail: string;
  x: number;
  z: number;
  base: number;
  source: string;
};

const SITES: SoundSite[] = [
  { id: 'san-pablo', label: 'San Pablo / Ashby', detail: 'west gateway', x: -4.4, z: 2.4, base: 68, source: 'arterial traffic' },
  { id: 'adeline', label: 'Adeline / Ashby', detail: 'BART corridor', x: -0.9, z: 1.7, base: 66, source: 'transit + traffic' },
  { id: 'shattuck', label: 'Shattuck / Ashby', detail: 'commercial edge', x: 2.3, z: 1.2, base: 62, source: 'street activity' },
  { id: 'mlk', label: 'MLK / Alcatraz', detail: 'residential seam', x: 2.7, z: -2.8, base: 54, source: 'local traffic' },
  { id: 'sacramento', label: 'Sacramento / 63rd', detail: 'neighborhood edge', x: -2.8, z: -3.1, base: 57, source: 'mixed traffic' }
];

const HOURS = [
  { value: 7, label: '07', name: 'morning', offset: 1 },
  { value: 12, label: '12', name: 'midday', offset: 2 },
  { value: 18, label: '18', name: 'evening', offset: 4 },
  { value: 23, label: '23', name: 'night', offset: -5 }
];

const BUILDINGS = [
  [-5.2, -3.8, 1.3, 0.8], [-3.5, -3.8, 1.1, 1.2], [-1.3, -3.7, 1.5, 0.9], [1.0, -3.7, 1.2, 1.4], [4.0, -3.7, 1.5, 0.8],
  [-5.1, -1.9, 1.2, 1.0], [-3.4, -1.8, 0.9, 1.5], [-1.2, -1.9, 1.4, 0.8], [1.0, -1.9, 1.1, 1.2], [4.2, -1.8, 1.4, 1.6],
  [-5.0, 0.3, 1.5, 1.2], [-3.1, 0.2, 1.0, 0.7], [-1.1, 0.1, 1.2, 1.4], [1.0, 0.2, 1.4, 0.9], [4.1, 0.2, 1.3, 1.2],
  [-5.1, 2.9, 1.1, 1.5], [-3.2, 3.0, 1.4, 0.8], [-1.0, 3.0, 1.0, 1.2], [1.2, 3.0, 1.5, 1.0], [4.1, 2.9, 1.1, 1.4]
] as const;

function offsetForHour(hour: number) {
  return HOURS.find((item) => item.value === hour)?.offset ?? 0;
}

function dbaColor(dba: number) {
  if (dba >= 70) return '#ff6b52';
  if (dba >= 62) return '#ffb24a';
  if (dba >= 56) return '#80d7b2';
  return '#5ec8ff';
}

function SoundPlume({ site, dba, selected, reducedMotion, onSelect }: { site: SoundSite; dba: number; selected: boolean; reducedMotion: boolean; onSelect: () => void }) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const height = Math.max(1.2, (dba - 45) * 0.13);
  const radius = 0.3 + Math.max(0, dba - 48) * 0.018;
  const color = dbaColor(dba);

  useFrame(({ clock }, delta) => {
    if (!group.current || !ring.current || reducedMotion) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 1.6 + site.x) * 0.045;
    group.current.scale.y = THREE.MathUtils.damp(group.current.scale.y, pulse, 4, delta);
    const ringScale = 1 + ((clock.elapsedTime * 0.22 + Math.abs(site.z) * 0.1) % 1) * 1.8;
    ring.current.scale.setScalar(ringScale);
    const material = ring.current.material as THREE.MeshBasicMaterial;
    material.opacity = 0.3 * (1 - (ringScale - 1) / 1.8);
  });

  return (
    <group ref={group} position={[site.x, 0, site.z]}>
      <mesh
        position={[0, height / 2 + 0.14, 0]}
        onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'default'; }}
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
      >
        <cylinderGeometry args={[radius * 0.22, radius, height, 28, 1, true]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 1.25 : 0.65} transparent opacity={selected ? 0.78 : 0.52} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.12, 0]}>
        <ringGeometry args={[radius * 1.1, radius * 1.17, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.26} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.105, 0]}>
        <circleGeometry args={[radius * (selected ? 1.25 : 0.9), 32]} />
        <meshBasicMaterial color={color} transparent opacity={selected ? 0.3 : 0.15} depthWrite={false} />
      </mesh>
      {selected && (
        <Html position={[0, height + 0.7, 0]} center distanceFactor={8} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-md border border-white/15 bg-[#071018]/90 px-2 py-1 font-mono text-[9px] text-white shadow-xl backdrop-blur">
            {site.label} · {dba} dBA
          </div>
        </Html>
      )}
    </group>
  );
}

function Ground({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <>
      <mesh position={[0, -0.18, 0]} receiveShadow>
        <boxGeometry args={[12, 0.28, 9.5]} />
        <meshStandardMaterial color="#0b1821" roughness={0.94} metalness={0.03} />
      </mesh>
      {[-4.4, -2.3, 0, 2.3, 4.4].map((x) => (
        <mesh key={`v-${x}`} position={[x, -0.01, 0]}>
          <boxGeometry args={[0.3, 0.04, 9.5]} />
          <meshStandardMaterial color={x === -4.4 ? '#21323d' : '#182832'} roughness={0.9} />
        </mesh>
      ))}
      {[-3.1, -1, 1.55, 3.45].map((z) => (
        <mesh key={`h-${z}`} position={[0, 0, z]}>
          <boxGeometry args={[12, z === 1.55 ? 0.055 : 0.04, z === 1.55 ? 0.42 : 0.28]} />
          <meshStandardMaterial color={z === 1.55 ? '#263944' : '#182832'} roughness={0.9} />
        </mesh>
      ))}
      {BUILDINGS.map(([x, z, height, tone], index) => (
        <mesh key={index} position={[x, height * 0.18, z]}>
          <boxGeometry args={[1.15, height * 0.36, 0.82]} />
          <meshStandardMaterial color={tone > 1 ? '#152832' : '#12232c'} roughness={0.78} metalness={0.08} />
        </mesh>
      ))}
      <gridHelper args={[12, 24, '#28404c', '#142630']} position={[0, 0.035, 0]} />
      {!reducedMotion && (
        <points position={[0, 0.15, 0]}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array(Array.from({ length: 180 }, (_, i) => ((i * 73) % 101) / 8 - (i % 3 === 1 ? 6 : i % 3 === 2 ? 0 : 0)).map((value, i) => i % 3 === 1 ? 0.06 + ((i * 7) % 9) / 90 : value)), 3]}
            />
          </bufferGeometry>
          <pointsMaterial color="#7bdcff" size={0.018} transparent opacity={0.35} sizeAttenuation />
        </points>
      )}
    </>
  );
}

function Scene({ hour, selectedId, onSelect, reducedMotion }: { hour: number; selectedId: string; onSelect: (id: string) => void; reducedMotion: boolean }) {
  const offset = offsetForHour(hour);
  return (
    <>
      <color attach="background" args={['#071018']} />
      <fog attach="fog" args={['#071018', 11, 24]} />
      <ambientLight intensity={0.75} color="#7fb7c9" />
      <directionalLight position={[5, 9, 4]} intensity={1.35} color="#d9f4ff" />
      <pointLight position={[-5, 5, 2]} intensity={18} distance={14} color="#4dc6ff" />
      <Ground reducedMotion={reducedMotion} />
      {SITES.map((site) => (
        <SoundPlume key={site.id} site={site} dba={site.base + offset} selected={site.id === selectedId} reducedMotion={reducedMotion} onSelect={() => onSelect(site.id)} />
      ))}
      <OrbitControls makeDefault enablePan={false} minDistance={8} maxDistance={19} minPolarAngle={0.55} maxPolarAngle={1.3} target={[0, 0.7, 0]} />
    </>
  );
}

export default function SouthBerkeleySoundFieldNode({ node, onPayload }: NodeBodyProps) {
  const initialHour = Number(node.payload.hour ?? 18);
  const [hour, setHour] = useState(HOURS.some((item) => item.value === initialHour) ? initialHour : 18);
  const [selectedId, setSelectedId] = useState('adeline');
  const reducedMotion = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const selected = SITES.find((site) => site.id === selectedId) ?? SITES[0];
  const selectedDba = selected.base + offsetForHour(hour);
  const average = Math.round(SITES.reduce((sum, site) => sum + site.base + offsetForHour(hour), 0) / SITES.length);

  const setTime = (value: number) => {
    setHour(value);
    onPayload({ hour: value, updatedAt: new Date().toISOString() });
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#071018] text-[#e9f5f7]" aria-label="South Berkeley modeled sound-level WebGL environment">
      <Canvas camera={{ position: [9.5, 9.2, 11], fov: 40, near: 0.1, far: 60 }} dpr={[1, 1.5]} gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}>
        <Scene hour={hour} selectedId={selectedId} onSelect={setSelectedId} reducedMotion={reducedMotion} />
      </Canvas>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-[#071018]/95 via-[#071018]/55 to-transparent p-4 pb-12">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-[#7dd6ee]">Acoustic topography / South Berkeley</div>
          <div className="mt-1 text-[22px] font-medium tracking-[-0.035em] text-white">The neighborhood, heard.</div>
        </div>
        <div className="rounded-full border border-[#ffcb72]/35 bg-[#ffb24a]/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-[#ffd38a]">
          modeled scenario · not live
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-4 left-4 w-[230px] rounded-lg border border-white/10 bg-[#09151d]/88 p-3 shadow-2xl backdrop-blur-md">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-[#7c98a4]">Selected field point</div>
            <div className="mt-1 text-[13px] font-medium text-white">{selected.label}</div>
            <div className="text-[10px] text-[#8ba2ad]">{selected.detail} · {selected.source}</div>
          </div>
          <div className="shrink-0 text-right">
            <span className="text-[28px] font-light leading-none" style={{ color: dbaColor(selectedDba) }}>{selectedDba}</span>
            <span className="ml-1 font-mono text-[9px] text-[#9db0b8]">dBA</span>
          </div>
        </div>
        <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(8, ((selectedDba - 40) / 40) * 100))}%`, background: dbaColor(selectedDba) }} />
        </div>
      </div>

      <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
        <div className="pointer-events-none flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.12em] text-[#89a0aa]">
          <span>quiet</span><span className="h-1 w-24 rounded-full bg-gradient-to-r from-[#5ec8ff] via-[#80d7b2] via-55% to-[#ff6b52]" /><span>loud</span>
        </div>
        <div className="flex rounded-full border border-white/10 bg-[#09151d]/88 p-1 shadow-xl backdrop-blur-md" aria-label="Time scenario">
          {HOURS.map((item) => (
            <button
              key={item.value}
              onClick={() => setTime(item.value)}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label={`Show ${item.name} sound scenario`}
              aria-pressed={hour === item.value}
              className={`rounded-full px-2.5 py-1 font-mono text-[9px] transition-colors ${hour === item.value ? 'bg-[#dff8ff] text-[#071018]' : 'text-[#8fa7b1] hover:text-white'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="pointer-events-none font-mono text-[8px] uppercase tracking-[0.14em] text-[#647d88]">weekday · area mean {average} dBA · drag to orbit</div>
      </div>

      <div className="sr-only" aria-live="polite">Selected {selected.label}, modeled {selectedDba} dBA for the {HOURS.find((item) => item.value === hour)?.name} scenario.</div>
    </div>
  );
}
