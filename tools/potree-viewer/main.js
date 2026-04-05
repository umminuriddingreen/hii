import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Scene setup ---
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x0a0a0a);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100000);
camera.position.set(0, 50, 100);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.1;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- State ---
let pointCloud = null;
let pointBudget = 1_000_000;
let pointSize = 2.0;

const statusEl = document.getElementById('status');
const welcomeEl = document.getElementById('welcome');
const loadingEl = document.getElementById('loading');
const progressEl = document.getElementById('loading-progress');

// --- Controls ---
const budgetSlider = document.getElementById('point-budget');
const sizeSlider = document.getElementById('point-size');

budgetSlider.addEventListener('input', () => {
  pointBudget = Number(budgetSlider.value);
  document.getElementById('budget-val').textContent =
    pointBudget >= 1_000_000 ? (pointBudget / 1_000_000).toFixed(1) + 'M' : (pointBudget / 1000) + 'K';
  if (pointCloud) {
    pointCloud.geometry.setDrawRange(0, Math.min(pointBudget, pointCloud.geometry.attributes.position.count));
  }
});

sizeSlider.addEventListener('input', () => {
  pointSize = Number(sizeSlider.value);
  document.getElementById('size-val').textContent = pointSize.toFixed(1);
  if (pointCloud) pointCloud.material.size = pointSize;
});

// --- LAS Parser (uncompressed) ---
function parseLASHeader(view) {
  const signature = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (signature !== 'LASF') throw new Error('Not a valid LAS/LAZ file');

  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const offsetToPoints = view.getUint32(96, true);
  const formatAndCompression = view.getUint8(104);
  const pointFormat = formatAndCompression & 0x3F;
  const isCompressed = (formatAndCompression & 0x80) !== 0;
  const pointRecordLength = view.getUint16(105, true);

  let numPoints;
  if (versionMajor === 1 && versionMinor >= 4) {
    numPoints = Number(view.getBigUint64(247, true));
  } else {
    numPoints = view.getUint32(107, true);
  }

  const scaleX = view.getFloat64(131, true);
  const scaleY = view.getFloat64(139, true);
  const scaleZ = view.getFloat64(147, true);
  const offsetX = view.getFloat64(155, true);
  const offsetY = view.getFloat64(163, true);
  const offsetZ = view.getFloat64(171, true);

  return {
    versionMajor, versionMinor, offsetToPoints, pointFormat,
    isCompressed, pointRecordLength, numPoints,
    scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ
  };
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1/3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1/3)];
}

function colorByElevation(z, minZ, maxZ) {
  const range = maxZ - minZ || 1;
  const normalized = (z - minZ) / range;
  const h = (1 - normalized) * 0.7; // blue(low) to red(high)
  return hslToRgb(h, 0.85, 0.5);
}

async function parseLASPoints(buffer, header) {
  const view = new DataView(buffer);
  const { offsetToPoints, pointRecordLength, numPoints, scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ, pointFormat } = header;

  const count = Math.min(numPoints, pointBudget);
  const step = numPoints > pointBudget ? Math.floor(numPoints / pointBudget) : 1;

  // First pass: find center and elevation range (sample)
  const sampleStep = Math.max(1, Math.floor(numPoints / 10000));
  let sumX = 0, sumY = 0, sumZ = 0, sampleCount = 0;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < numPoints; i += sampleStep) {
    const off = offsetToPoints + i * pointRecordLength;
    if (off + 12 > buffer.byteLength) break;
    const z = view.getInt32(off + 8, true) * scaleZ + offsetZ;
    const x = view.getInt32(off, true) * scaleX + offsetX;
    const y = view.getInt32(off + 4, true) * scaleY + offsetY;
    sumX += x; sumY += y; sumZ += z;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    sampleCount++;
  }

  const cx = sumX / sampleCount;
  const cy = sumY / sampleCount;
  const cz = sumZ / sampleCount;

  // Check for RGB in point format
  const hasColor = [2, 3, 5, 7, 8].includes(pointFormat);
  let colorOff = 20;
  if (pointFormat === 2) colorOff = 20;
  else if (pointFormat === 3 || pointFormat === 5) colorOff = 28;
  else if (pointFormat === 7 || pointFormat === 8) colorOff = 30;

  // Second pass: read points
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let idx = 0;

  for (let i = 0; i < numPoints && idx < count; i += step) {
    const off = offsetToPoints + i * pointRecordLength;
    if (off + 12 > buffer.byteLength) break;

    const x = view.getInt32(off, true) * scaleX + offsetX - cx;
    const y = view.getInt32(off + 4, true) * scaleY + offsetY - cy;
    const z = view.getInt32(off + 8, true) * scaleZ + offsetZ - cz;

    positions[idx * 3] = x;
    positions[idx * 3 + 1] = z;     // Z up → Y up
    positions[idx * 3 + 2] = -y;

    if (hasColor && off + colorOff + 6 <= buffer.byteLength) {
      const r = view.getUint16(off + colorOff, true);
      const g = view.getUint16(off + colorOff + 2, true);
      const b = view.getUint16(off + colorOff + 4, true);
      // Detect 8-bit vs 16-bit colors
      if (r > 255 || g > 255 || b > 255) {
        colors[idx * 3] = r / 65535;
        colors[idx * 3 + 1] = g / 65535;
        colors[idx * 3 + 2] = b / 65535;
      } else {
        colors[idx * 3] = r / 255;
        colors[idx * 3 + 1] = g / 255;
        colors[idx * 3 + 2] = b / 255;
      }
    } else {
      const c = colorByElevation(view.getInt32(off + 8, true) * scaleZ + offsetZ, minZ, maxZ);
      colors[idx * 3] = c[0];
      colors[idx * 3 + 1] = c[1];
      colors[idx * 3 + 2] = c[2];
    }

    idx++;
    if (idx % 500000 === 0) {
      progressEl.textContent = Math.round(idx / count * 100) + '%';
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { positions: positions.subarray(0, idx * 3), colors: colors.subarray(0, idx * 3), count: idx };
}

// --- LAZ Decompression via Worker approach ---
// For LAZ files, we use a server-side conversion or pdal if available
// Fallback: try to read as if uncompressed (will show header info at minimum)

async function loadFile(file) {
  welcomeEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  progressEl.textContent = 'Reading...';
  statusEl.textContent = '';

  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    const header = parseLASHeader(view);

    statusEl.textContent = `LAS ${header.versionMajor}.${header.versionMinor} | fmt:${header.pointFormat} | ${header.numPoints.toLocaleString()} pts`;

    if (header.isCompressed) {
      statusEl.textContent += ' | LAZ compressed — decompressing...';
      // Use laz-perf WASM for decompression
      const data = await decompressAndParseLAZ(buffer, header);
      loadingEl.classList.add('hidden');
      displayPointCloud(data);
    } else {
      const data = await parseLASPoints(buffer, header);
      loadingEl.classList.add('hidden');
      displayPointCloud(data);
    }
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    loadingEl.classList.add('hidden');
    console.error(e);
  }
}

// --- LAZ decompression using laz-perf ---
async function decompressAndParseLAZ(buffer, header) {
  progressEl.textContent = 'Loading decompressor...';

  // Load laz-perf as a script (not ES module)
  const lazPerfUrl = 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.6/lib/laz-perf.js';

  // Create a worker blob that handles decompression
  const workerCode = `
    importScripts('${lazPerfUrl}');

    self.onmessage = async function(e) {
      const { buffer, header } = e.data;
      try {
        // Initialize laz-perf
        const Module = await self.lazPerf();

        const view = new DataView(buffer);
        const { offsetToPoints, pointRecordLength, numPoints, scaleX, scaleY, scaleZ, offsetX, offsetY, offsetZ, pointFormat, pointBudget } = header;

        const fileBytes = new Uint8Array(buffer);
        const dataPtr = Module._malloc(buffer.byteLength);
        Module.HEAPU8.set(fileBytes, dataPtr);

        const decoder = new Module.LASZip();
        const ok = decoder.open(dataPtr, buffer.byteLength);

        if (!ok) {
          Module._free(dataPtr);
          throw new Error('Failed to open LAZ');
        }

        const count = decoder.getCount();
        const actualCount = Math.min(count, pointBudget);
        const step = count > pointBudget ? Math.floor(count / pointBudget) : 1;

        const pointSize = decoder.getPointDataRecordLength();
        const pointPtr = Module._malloc(pointSize);

        // Sample for centering
        decoder.getPoint(pointPtr);
        const pb = new DataView(Module.HEAPU8.buffer, pointPtr, pointSize);
        const cx = pb.getInt32(0, true) * scaleX + offsetX;
        const cy = pb.getInt32(4, true) * scaleY + offsetY;
        const cz = pb.getInt32(8, true) * scaleZ + offsetZ;
        let minZ = cz, maxZ = cz;

        const positions = new Float32Array(actualCount * 3);
        const elevations = new Float32Array(actualCount);
        let idx = 0;

        for (let i = 0; i < count && idx < actualCount; i++) {
          decoder.getPoint(pointPtr);
          if (i % step !== 0) continue;

          const pv = new DataView(Module.HEAPU8.buffer, pointPtr, pointSize);
          const x = pv.getInt32(0, true) * scaleX + offsetX - cx;
          const y = pv.getInt32(4, true) * scaleY + offsetY - cy;
          const z = pv.getInt32(8, true) * scaleZ + offsetZ - cz;
          const absZ = pv.getInt32(8, true) * scaleZ + offsetZ;

          positions[idx * 3] = x;
          positions[idx * 3 + 1] = z;
          positions[idx * 3 + 2] = -y;
          elevations[idx] = absZ;

          if (absZ < minZ) minZ = absZ;
          if (absZ > maxZ) maxZ = absZ;

          idx++;
          if (idx % 200000 === 0) {
            self.postMessage({ type: 'progress', value: Math.round(idx / actualCount * 100) });
          }
        }

        Module._free(pointPtr);
        Module._free(dataPtr);

        self.postMessage({
          type: 'done',
          positions: positions.subarray(0, idx * 3),
          elevations: elevations.subarray(0, idx),
          count: idx,
          minZ, maxZ
        }, [positions.buffer, elevations.buffer]);
      } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
      }
    };
  `;

  // laz-perf WASM CDN approach is unreliable. Let's use a pure-JS fallback.
  // Actually, let's try a different approach: use the 'las-js' style direct reading
  // by converting via a fetch to pdal or using the copc.js library

  // Simpler: fetch copc.js which includes laz-perf bundled
  progressEl.textContent = 'Loading LAZ decoder...';

  // Use dynamic script loading for copc
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/copc@0.0.6/dist/copc.min.js';

  const copcLoaded = new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = reject;
  });

  document.head.appendChild(script);

  try {
    await copcLoaded;
    progressEl.textContent = 'Decoding LAZ...';
    // copc.js API
    const { Las } = window.Copc;
    const file = Las.MemoryReader.fromBuffer(buffer);
    const las = await Las.create(file);

    const count = Math.min(header.numPoints, pointBudget);
    const step = header.numPoints > pointBudget ? Math.floor(header.numPoints / pointBudget) : 1;

    const view = await las.getView();
    let cx = 0, cy = 0, cz = 0, minZ = Infinity, maxZ = -Infinity;

    // Sample for centering
    for (let i = 0; i < Math.min(header.numPoints, 10000); i += Math.max(1, Math.floor(header.numPoints / 10000))) {
      const p = view.getPosition(i);
      cx += p.x; cy += p.y; cz += p.z;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const sn = Math.min(header.numPoints, 10000);
    cx /= sn; cy /= sn; cz /= sn;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    let idx = 0;

    for (let i = 0; i < header.numPoints && idx < count; i += step) {
      const p = view.getPosition(i);
      positions[idx * 3] = p.x - cx;
      positions[idx * 3 + 1] = p.z - cz;
      positions[idx * 3 + 2] = -(p.y - cy);

      const c = colorByElevation(p.z, minZ, maxZ);
      colors[idx * 3] = c[0];
      colors[idx * 3 + 1] = c[1];
      colors[idx * 3 + 2] = c[2];
      idx++;

      if (idx % 200000 === 0) {
        progressEl.textContent = Math.round(idx / count * 100) + '%';
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return { positions: positions.subarray(0, idx * 3), colors: colors.subarray(0, idx * 3), count: idx };
  } catch (copcErr) {
    console.warn('copc.js failed:', copcErr);
    // Final fallback: tell user to convert
    throw new Error('LAZ decompression not available in browser. Convert to .las first using: pdal translate input.laz output.las');
  }
}

// --- Display ---
function displayPointCloud(data) {
  if (pointCloud) {
    scene.remove(pointCloud);
    pointCloud.geometry.dispose();
    pointCloud.material.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));

  const material = new THREE.PointsMaterial({
    size: pointSize,
    vertexColors: true,
    sizeAttenuation: true,
  });

  pointCloud = new THREE.Points(geometry, material);
  scene.add(pointCloud);
  fitToView();

  statusEl.textContent += ` | Showing ${data.count.toLocaleString()} pts`;
}

function fitToView() {
  if (!pointCloud) return;
  const box = new THREE.Box3().setFromObject(pointCloud);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();

  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(size * 0.5, size * 0.5, size * 0.5));
  camera.near = size * 0.001;
  camera.far = size * 10;
  camera.updateProjectionMatrix();
  controls.update();
}

// --- UI ---
document.getElementById('btn-load').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
document.getElementById('btn-fit').addEventListener('click', fitToView);

// Drag and drop
let dragCounter = 0;
const dropOverlay = document.getElementById('drop-overlay');
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.add('visible'); });
document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('visible'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('visible');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

// Keyboard
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') fitToView();
});

// --- Auto-load from URL params ---
const params = new URLSearchParams(window.location.search);
const fileParam = params.get('file');
if (fileParam) {
  welcomeEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  statusEl.textContent = 'Fetching...';
  fetch(fileParam)
    .then(r => r.arrayBuffer())
    .then(buf => {
      const f = new File([buf], fileParam.split('/').pop() || 'cloud.laz');
      loadFile(f);
    })
    .catch(e => { statusEl.textContent = 'Fetch error: ' + e.message; loadingEl.classList.add('hidden'); });
}

// --- FPS ---
const fpsEl = document.getElementById('fps-counter');
let frameCount = 0, lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  frameCount++;
  const now = performance.now();
  if (now - lastTime >= 1000) {
    fpsEl.textContent = frameCount + ' FPS';
    frameCount = 0;
    lastTime = now;
  }
}
animate();
