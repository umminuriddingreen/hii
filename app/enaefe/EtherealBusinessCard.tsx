'use client';

import { useEffect, useRef } from 'react';

const domain = 'https://enaefe.com';

export default function EtherealBusinessCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let frame = 0;
    let disposed = false;
    let cleanup = () => {};

    async function boot() {
      const loadThree = new Function('return import("/vendor/three.module.js")') as () => Promise<any>;
      const THREE = await loadThree();

      if (!canvasRef.current || disposed) return;

      const canvas = canvasRef.current;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
      camera.position.set(0, 0.35, 11.2);

      const root = new THREE.Group();
      root.scale.setScalar(0.66);
      root.position.set(0.15, 0.28, 0);
      scene.add(root);

      function makeCanvasTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
        const textureCanvas = document.createElement('canvas');
        textureCanvas.width = 1600;
        textureCanvas.height = 900;
        const ctx = textureCanvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        draw(ctx, textureCanvas.width, textureCanvas.height);
        const texture = new THREE.CanvasTexture(textureCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        return texture;
      }

      const frontTexture = makeCanvasTexture((ctx, w, h) => {
        ctx.fillStyle = '#ff2418';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#351316';
        ctx.font = '900 330px Arial Black, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('E', w / 2, h / 2 + 12);
      });

      const qrTexture = makeCanvasTexture((ctx, w, h) => {
        ctx.fillStyle = '#ff2418';
        ctx.fillRect(0, 0, w, h);

        const module = 42;
        const originX = w / 2 - 15 * module;
        const originY = h / 2 - 15 * module;

        function darkRect(x: number, y: number, width: number, height: number) {
          ctx.fillStyle = '#351316';
          ctx.fillRect(originX + x * module, originY + y * module, width * module, height * module);
        }

        function finder(x: number, y: number) {
          darkRect(x, y, 7, 7);
          ctx.fillStyle = '#ff2418';
          ctx.fillRect(originX + (x + 1) * module, originY + (y + 1) * module, 5 * module, 5 * module);
          darkRect(x + 2, y + 2, 3, 3);
        }

        finder(2, 2);
        finder(22, 2);
        finder(2, 20);

        [
          [12, 4, 3, 3], [16, 4, 2, 5], [19, 9, 3, 2], [10, 11, 3, 4],
          [15, 12, 6, 3], [23, 13, 4, 4], [11, 18, 5, 2], [17, 20, 4, 5],
          [24, 22, 3, 3], [10, 25, 4, 3], [15, 27, 2, 2], [20, 26, 7, 2],
          [28, 12, 1, 2], [8, 16, 2, 1], [14, 22, 1, 3], [21, 18, 2, 1]
        ].forEach(([x, y, width, height]) => darkRect(x, y, width, height));
      });

      const cardGeometry = new THREE.BoxGeometry(3.72, 2.16, 0.08, 8, 8, 1);
      const cardMaterial = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#ff2418'),
        metalness: 0.06,
        roughness: 0.48,
        clearcoat: 0.38,
        clearcoatRoughness: 0.36
      });

      function makeCard(texture: any, x: number, y: number, z: number, ry: number) {
        const card = new THREE.Mesh(cardGeometry, cardMaterial.clone());
        const face = new THREE.Mesh(
          new THREE.PlaneGeometry(3.58, 2.02),
          new THREE.MeshBasicMaterial({ map: texture })
        );
        face.position.z = 0.046;
        card.add(face);
        card.position.set(x, y, z);
        card.rotation.y = ry;
        root.add(card);
        return card;
      }

      const frontCard = makeCard(frontTexture, -2.16, -0.07, 0, -0.17);
      const qrCard = makeCard(qrTexture, 2.16, 0.03, -0.08, 0.15);

      const scaffold = new THREE.Group();
      const lineMaterial = new THREE.LineBasicMaterial({
        color: '#f36b21',
        transparent: true,
        opacity: 0.72
      });

      for (let i = 0; i < 8; i += 1) {
        const x = -3.8 + i * 1.05;
        scaffold.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(x, -1.72, -0.38),
              new THREE.Vector3(x + 0.58, 1.66, -0.38)
            ]),
            lineMaterial
          )
        );
      }

      for (let i = 0; i < 5; i += 1) {
        const y = -1.58 + i * 0.78;
        scaffold.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(-3.9, y, -0.39),
              new THREE.Vector3(3.9, y + 0.25, -0.39)
            ]),
            lineMaterial
          )
        );
      }

      root.add(scaffold);

      const labelTexture = makeCanvasTexture((ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#eee7dd';
        ctx.font = '700 54px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('artboard', 112, 82);
        ctx.fillText('artboard', 910, 82);
        ctx.fillStyle = '#8e817a';
        ctx.font = '500 36px Arial, sans-serif';
        ctx.fillText('simplify. simplify.', 112, 810);
        ctx.fillText('enaefe.com', 910, 810);
      });

      const labelPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(7.8, 4.4),
        new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true })
      );
      labelPlane.position.z = 0.15;
      root.add(labelPlane);

      const columns = new THREE.Group();
      const columnMaterial = new THREE.MeshStandardMaterial({
        color: '#ede6dd',
        roughness: 0.62,
        metalness: 0.02
      });
      const orangeMaterial = new THREE.MeshBasicMaterial({ color: '#f36b21', wireframe: true });

      for (let i = 0; i < 5; i += 1) {
        const height = 0.55 + i * 0.18;
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, height, 16), columnMaterial);
        column.position.set(-3.15 + i * 0.24, -1.58 + height / 2, -0.22);
        columns.add(column);
      }

      const lattice = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.58, 0.18, 5, 3, 1), orangeMaterial);
      lattice.position.set(-2.55, -1.16, -0.2);
      lattice.rotation.z = -0.25;
      columns.add(lattice);
      root.add(columns);

      scene.add(new THREE.AmbientLight('#f2ece3', 1.55));
      const keyLight = new THREE.DirectionalLight('#ffffff', 1.75);
      keyLight.position.set(2.7, 4.4, 4.9);
      scene.add(keyLight);
      const rimLight = new THREE.PointLight('#ff5a2a', 4.8, 14);
      rimLight.position.set(-3.8, -2, 3.2);
      scene.add(rimLight);

      const pointer = new THREE.Vector2(0, 0);
      let dragging = false;
      let spin = 0;

      function setPointer(event: PointerEvent) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
        pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      }

      function onPointerMove(event: PointerEvent) {
        setPointer(event);
      }
      function onPointerDown(event: PointerEvent) {
        dragging = true;
        setPointer(event);
      }
      function onPointerUp() {
        dragging = false;
      }

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointerup', onPointerUp);

      function resize() {
        const { clientWidth, clientHeight } = canvas;
        renderer.setSize(clientWidth, clientHeight, false);
        camera.aspect = clientWidth / Math.max(clientHeight, 1);
        camera.updateProjectionMatrix();
      }

      function animate(timeMs: number) {
        const time = timeMs / 1000;
        resize();
        spin += dragging ? 0.018 : 0.004;

        root.rotation.y += (pointer.x * 0.12 + Math.sin(time * 0.45) * 0.032 + spin * 0.006 - root.rotation.y) * 0.06;
        root.rotation.x += (-pointer.y * 0.08 + Math.sin(time * 0.6) * 0.018 - root.rotation.x) * 0.06;
        frontCard.rotation.z = -0.015 + Math.sin(time * 0.7) * 0.006;
        qrCard.rotation.z = 0.012 + Math.cos(time * 0.65) * 0.006;
        scaffold.rotation.z = Math.sin(time * 0.4) * 0.012;
        columns.rotation.y = Math.sin(time * 0.55) * 0.06;
        root.position.x = 0.15;
        root.position.y = 0.28 + Math.sin(time * 0.8) * 0.06;

        renderer.render(scene, camera);
        frame = requestAnimationFrame(animate);
      }

      frame = requestAnimationFrame(animate);

      cleanup = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointerup', onPointerUp);
        renderer.dispose();
        frontTexture.dispose();
        qrTexture.dispose();
        labelTexture.dispose();
        cardGeometry.dispose();
        cardMaterial.dispose();
        lineMaterial.dispose();
        columnMaterial.dispose();
        orangeMaterial.dispose();
      };
    }

    boot().catch((error) => {
      console.error(error);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return (
    <section className="relative left-1/2 min-h-[calc(100vh-73px)] w-screen -translate-x-1/2 overflow-hidden bg-[#171314] text-[#f2ece3]">
      <div className="grid min-h-[calc(100vh-73px)] grid-cols-1 lg:h-[calc(100vh-73px)] lg:grid-cols-[1.25fr_0.75fr]">
        <div className="relative min-h-[58vh] overflow-hidden border-b border-[#f2ece32e] lg:h-full lg:min-h-0 lg:border-b-0 lg:border-r">
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,36,24,0.045)_1px,transparent_1px),linear-gradient(0deg,rgba(255,36,24,0.035)_1px,transparent_1px)] bg-[length:48px_48px]" />
        </div>

        <div className="flex min-h-screen flex-col justify-center gap-6 overflow-y-auto bg-[#111111cc] px-6 py-10 backdrop-blur lg:min-h-0 lg:px-14">
          <p className="text-xs font-black uppercase tracking-normal text-[#f36b21]">Ethereal Atelier</p>
          <h1 className="text-[clamp(8rem,18vw,15rem)] font-black leading-[0.78] tracking-normal">E</h1>
          <p className="max-w-xl text-lg leading-7 text-[#c5b9b1]">
            Enaefe Aghoghovbia is an architecture undergraduate at New Jersey Institute of
            Technology and an emerging designer working across architectural graphics, model
            making, Revit, Rhino, Photoshop, and InDesign.
          </p>

          <div className="grid grid-cols-[116px_minmax(0,1fr)] items-center gap-5 rounded-lg border border-[#f2ece32e] bg-[#ff24181a] p-4 max-[520px]:grid-cols-1">
            <img
              src="/enaefe/qr-red.svg"
              alt="QR code linking to enaefe.com"
              className="h-[116px] w-[116px] rounded-md bg-[#ff2418]"
            />
            <div>
              <h2 className="text-lg font-extrabold">Scan to open</h2>
              <a className="font-bold text-[#f36b21] no-underline hover:underline" href={domain}>
                enaefe.com
              </a>
            </div>
          </div>

          <dl className="grid overflow-hidden rounded-lg border border-[#f2ece32e] bg-[#f2ece32e]">
            {[
              ['Name', 'Enaefe Aghoghovbia'],
              ['Studio', 'Ethereal Atelier'],
              ['Role', 'Architecture undergraduate / designer'],
              ['School', 'New Jersey Institute of Technology, B.Arch 2023-2026'],
              ['Experience', 'Architectural Designer Intern, Alsieux Architecture'],
              ['Tagline', 'simplify. simplify.'],
              ['Tools', 'Rhino, Revit, Adobe Photoshop, Adobe InDesign'],
              ['Instagram', '@etherealatelier / @eeenaefe'],
              ['Domain', 'enaefe.com'],
              ['DNS', 'Cargo or Cloudflare configuration still needs to resolve']
            ].map(([label, value]) => (
              <div key={label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 bg-[#111111e0] p-4 max-[520px]:grid-cols-1">
                <dt className="text-xs font-black uppercase text-[#f36b21]">{label}</dt>
                <dd className="m-0 leading-6 text-[#c5b9b1]">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
