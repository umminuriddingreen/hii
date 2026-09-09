'use client';

// SPDX-License-Identifier: LicenseRef-BSL-1.1

import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { workspaceNodeTitle } from '@/lib/workspace/search';
import { workspaceHandles } from '@/lib/workspace/handles';
import { workspaceNodeTransform3D, type WorkspaceNode } from '@/lib/workspace/types';

/**
 * The 3D projection of the workspace.
 *
 * This is not a second canvas. It renders the same `WorkspaceNode[]` the 2D
 * surface renders, positioned by the same authoritative `transform`, and every
 * move it makes is written back through the same patch path — so an object
 * dragged here has moved in plan, in the terminal's addressing, and for any
 * agent reading the document, without a synchronization step existing anywhere.
 *
 * Depth is `transform.position.z` and nothing else. A card authored in 2D sits
 * at zero, which is why an untouched workspace opens as a flat plane you are
 * looking at from an angle rather than as scattered debris.
 */

/** Workspace pixels per world unit. Keeps a default 380px card near 4 units wide. */
const UNIT = 100;

const TYPE_COLOR: Record<string, string> = {
  run: '#8ee8b0',
  intent: '#8caeff',
  terminal: '#9aa4b2',
  browser: '#c7a6ff',
  image: '#ffd08a',
  document: '#e8e2d4',
  file: '#e8e2d4',
  note: '#f3e59a',
  'canvas-text': '#f3e59a',
  ink: '#ff9db1',
  model: '#7fe6d8',
  cad: '#7fe6d8',
  board: '#a8b4c4',
  context: '#b8c0cc'
};

const STATUS_COLOR: Record<string, string> = {
  running: '#8ee8b0',
  failed: '#ff746c',
  waiting_approval: '#ffc266',
  proposed: '#ffc266',
  completed: '#78d5b0'
};

function colorFor(node: WorkspaceNode) {
  const status = node.object?.status;
  if (status && STATUS_COLOR[status]) return STATUS_COLOR[status];
  return TYPE_COLOR[node.type] || '#8f97a3';
}

type SceneNodeProps = {
  node: WorkspaceNode;
  handle?: string;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onMove: (id: string, position: { x: number; y: number; z: number }) => void;
  showLabels: boolean;
};

function SceneNode({ node, handle, selected, onSelect, onMove, showLabels }: SceneNodeProps) {
  const transform = workspaceNodeTransform3D(node);
  const { camera, gl } = useThree();
  const dragging = useRef(false);
  const plane = useRef(new THREE.Plane());
  const offset = useRef(new THREE.Vector3());
  const hit = useRef(new THREE.Vector3());
  const raycaster = useRef(new THREE.Raycaster());
  const pointer = useRef(new THREE.Vector2());
  const [hovered, setHovered] = useState(false);

  const width = Math.max(0.4, transform.size.x / UNIT);
  const height = Math.max(0.3, transform.size.y / UNIT);

  // Workspace Y grows downward; world Y grows up. Flipping here keeps a card
  // that is above another in plan above it in the scene as well.
  const position = useMemo<[number, number, number]>(
    () => [transform.position.x / UNIT, -transform.position.y / UNIT, transform.position.z / UNIT],
    [transform.position.x, transform.position.y, transform.position.z]
  );

  const quaternion = useMemo<[number, number, number, number]>(
    () => [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w],
    [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w]
  );

  const pointerFromEvent = useCallback((event: PointerEvent) => {
    const rect = gl.domElement.getBoundingClientRect();
    pointer.current.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    return pointer.current;
  }, [gl]);

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelect(node.id, event.shiftKey);
    dragging.current = true;
    (event.target as Element)?.setPointerCapture?.(event.pointerId);

    // Drag in the plane facing the camera through the object, so movement
    // tracks the pointer from any orbit angle rather than only head-on.
    const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
    plane.current.setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...position));
    offset.current.copy(new THREE.Vector3(...position)).sub(event.point);
  };

  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    event.stopPropagation();
    raycaster.current.setFromCamera(pointerFromEvent(event.nativeEvent), camera);
    if (!raycaster.current.ray.intersectPlane(plane.current, hit.current)) return;
    const next = hit.current.clone().add(offset.current);
    onMove(node.id, { x: next.x * UNIT, y: -next.y * UNIT, z: next.z * UNIT });
  };

  const endDrag = (event: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    dragging.current = false;
    (event.target as Element)?.releasePointerCapture?.(event.pointerId);
  };

  const color = colorFor(node);
  const running = node.object?.status === 'running';

  return (
    <group position={position} quaternion={quaternion}>
      <mesh
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
      >
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={running ? 0.5 : selected ? 0.3 : hovered ? 0.18 : 0.06}
          transparent
          opacity={selected ? 0.96 : 0.82}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Selection frame, drawn slightly forward so it is never z-fought. */}
      {selected && (
        <lineSegments position={[0, 0, 0.002]}>
          <edgesGeometry args={[new THREE.PlaneGeometry(width * 1.04, height * 1.08)]} />
          <lineBasicMaterial color="#ffffff" />
        </lineSegments>
      )}

      {/* A card lifted off the ground plane gets a stem, so height reads as
          height rather than as the card having drifted in the view. */}
      {Math.abs(transform.position.z) > 0.5 && (
        <line>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[new Float32Array([0, 0, 0, 0, 0, -transform.position.z / UNIT]), 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial color={color} transparent opacity={0.35} />
        </line>
      )}

      {showLabels && (
        <Text
          position={[0, height / 2 + 0.13, 0.01]}
          fontSize={0.15}
          color={selected ? '#ffffff' : '#c8cdd6'}
          anchorX="center"
          anchorY="bottom"
          maxWidth={Math.max(width, 2)}
          outlineWidth={0.008}
          outlineColor="#0b0d10"
        >
          {handle ? `@${handle}` : workspaceNodeTitle(node)}
        </Text>
      )}
    </group>
  );
}

function GroundPlane() {
  return (
    <gridHelper
      args={[200, 100, '#2a2f38', '#1a1e25']}
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, 0, -0.01]}
    />
  );
}

export type WorkspaceScene3DProps = {
  nodes: WorkspaceNode[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onMove: (id: string, position: { x: number; y: number; z: number }) => void;
  showLabels?: boolean;
};

export function WorkspaceScene3D({ nodes, selectedIds, onSelect, onMove, showLabels = true }: WorkspaceScene3DProps) {
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const handles = useMemo(() => {
    const table = workspaceHandles(nodes);
    return new Map(table.map((entry) => [entry.nodeId, entry.handle]));
  }, [nodes]);

  const select = useCallback((id: string, additive: boolean) => {
    if (!additive) {
      onSelect([id]);
      return;
    }
    onSelect(selected.has(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  }, [onSelect, selected, selectedIds]);

  // Frame the work rather than the origin: an empty region of grid is not a view.
  const center = useMemo(() => {
    if (!nodes.length) return new THREE.Vector3(0, 0, 0);
    const box = new THREE.Box3();
    for (const node of nodes) {
      const transform = workspaceNodeTransform3D(node);
      box.expandByPoint(new THREE.Vector3(
        transform.position.x / UNIT,
        -transform.position.y / UNIT,
        transform.position.z / UNIT
      ));
    }
    return box.getCenter(new THREE.Vector3());
  }, [nodes]);

  const radius = useMemo(() => {
    if (!nodes.length) return 12;
    let max = 4;
    for (const node of nodes) {
      const transform = workspaceNodeTransform3D(node);
      max = Math.max(max, Math.hypot(
        transform.position.x / UNIT - center.x,
        -transform.position.y / UNIT - center.y
      ));
    }
    return Math.min(90, max * 1.9 + 6);
  }, [nodes, center]);

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [center.x, center.y - radius * 0.75, radius * 0.8], fov: 45, near: 0.1, far: 1000 }}
      onPointerMissed={() => onSelect([])}
      gl={{ antialias: true }}
    >
      <color attach="background" args={['#0b0d10']} />
      <fog attach="fog" args={['#0b0d10', radius * 1.4, radius * 4]} />
      <ambientLight intensity={0.9} />
      <directionalLight position={[6, 10, 12]} intensity={0.7} />
      <GroundPlane />
      {nodes.map((node) => (
        <SceneNode
          key={node.id}
          node={node}
          handle={handles.get(node.id)}
          selected={selected.has(node.id)}
          onSelect={select}
          onMove={onMove}
          showLabels={showLabels}
        />
      ))}
      <OrbitControls
        makeDefault
        target={[center.x, center.y, 0]}
        enableDamping
        dampingFactor={0.12}
        maxPolarAngle={Math.PI * 0.95}
      />
    </Canvas>
  );
}
