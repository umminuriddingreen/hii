import { HiiTerminal } from './HiiTerminal';
import { surfaceEnabled } from '@/lib/server/hii-config';
import { SurfaceDisabled } from '@/components/SurfaceDisabled';

export const dynamic = 'force-dynamic';

export default function TerminalPage() {
  if (!surfaceEnabled('terminal')) return <SurfaceDisabled name="terminal" />;
  return <HiiTerminal />;
}
