import { redirect } from 'next/navigation';
import { HiiRoot } from '../../components/workspace/HiiRoot';
import { readHiiConfig } from '@/lib/server/hii-config';
import { SurfaceDisabled } from '@/components/SurfaceDisabled';

export const dynamic = 'force-dynamic';

export default function Home() {
  const config = readHiiConfig();
  const homepage = config.defaults.homepage || 'workspace';
  if (homepage !== 'workspace') redirect(`/${homepage}`);
  if (config.surfaces.workspace?.enabled === false) return <SurfaceDisabled name="HII" />;
  return <HiiRoot />;
}
