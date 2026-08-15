'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { WorkspaceNode } from '@/lib/workspace/types';

type SpatialActivityLayerProps = {
  nodes: WorkspaceNode[];
  selectedIds: string[];
};

type Signal = {
  id: string;
  position: [number, number, number];
  color: string;
  running: boolean;
  selected: boolean;
  groupId: string;
};

const STATUS_COLOR: Record<string, string> = {
  completed: '#78d5b0',
  failed: '#ff746c',
  queued: '#737884',
  ready: '#8caeff',
  running: '#8ee8b0'
};

function stableUnit(value: string, salt: number) {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function signalsFor(nodes: WorkspaceNode[], selectedIds: string[]): Signal[] {
  const selected = new Set(selectedIds);
  return nodes.slice(-48).map((node) => {
    const status = String(node.object?.status || node.payload.status || 'ready');
    const isSelected = selected.has(node.id);
    return {
      id: node.id,
      position: [
        (stableUnit(node.id, 11) - 0.5) * 12,
        (stableUnit(node.id, 29) - 0.5) * 7,
        isSelected ? 1.25 : -1.2 - stableUnit(node.id, 47) * 4.8
      ],
      color: STATUS_COLOR[status] || '#8caeff',
      running: status === 'running',
      selected: isSelected,
      groupId: String(node.payload.groupId || node.object?.parentId || '')
    };
  });
}

function DepthLoom({ nodes, selectedIds, still }: SpatialActivityLayerProps & { still: boolean }) {
  const root = useRef<THREE.Group>(null);
  const signals = useMemo(() => signalsFor(nodes, selectedIds), [nodes, selectedIds]);
  const linePositions = useMemo(() => {
    const positions: number[] = [];
    signals.forEach((signal, index) => {
      const prior = signals.slice(0, index).reverse().find((candidate) =>
        signal.groupId ? candidate.groupId === signal.groupId : index - signals.indexOf(candidate) <= 2
      );
      if (!prior) return;
      positions.push(...prior.position, ...signal.position);
    });
    return new Float32Array(positions);
  }, [signals]);

  useFrame((state, delta) => {
    if (!root.current || still) return;
    const targetX = state.pointer.y * 0.07;
    const targetY = state.pointer.x * 0.1;
    root.current.rotation.x = THREE.MathUtils.damp(root.current.rotation.x, targetX, 3, delta);
    root.current.rotation.y = THREE.MathUtils.damp(root.current.rotation.y, targetY, 3, delta);
    root.current.position.z = Math.sin(state.clock.elapsedTime * 0.16) * 0.08;
  });

  return (
    <group ref={root}>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[linePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#8290a8" transparent opacity={0.1} depthWrite={false} />
      </lineSegments>
      {signals.map((signal, index) => (
        <mesh key={signal.id} position={signal.position} scale={signal.selected ? 1.7 : signal.running ? 1.15 : 0.72}>
          <octahedronGeometry args={[0.055, 0]} />
          <meshBasicMaterial
            color={signal.color}
            transparent
            opacity={signal.selected ? 0.85 : signal.running ? 0.62 : 0.28 + (index % 3) * 0.05}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

export function SpatialActivityLayer({ nodes, selectedIds }: SpatialActivityLayerProps) {
  const [still, setStill] = useState(true);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return (
    <div className="hii-spatial-activity" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 8], fov: 45, near: 0.1, far: 40 }}
        dpr={[1, 1.35]}
        frameloop={still ? 'demand' : 'always'}
        gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
      >
        <DepthLoom nodes={nodes} selectedIds={selectedIds} still={still} />
      </Canvas>
    </div>
  );
}
