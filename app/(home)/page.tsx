import { redirect } from 'next/navigation';
import { CanvasRoot } from '../../components/canvas/CanvasRoot';
import { readHiiConfig } from '@/lib/server/hii-config';
import { SurfaceDisabled } from '@/components/SurfaceDisabled';

export const dynamic = 'force-dynamic';

export default function Home() {
  const config = readHiiConfig();
  const homepage = config.defaults.homepage || 'canvas';
  if (homepage !== 'canvas') redirect(`/${homepage}`);
  if (config.surfaces.canvas?.enabled === false) return <SurfaceDisabled name="canvas" />;
  return <CanvasRoot />;
}
