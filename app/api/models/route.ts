import { NextResponse } from 'next/server';
import { localTerminalAllowed } from '@/lib/server/hii-terminal';
import { readModelCatalog, routeModel, type ModelModality, type ModelPrivacy } from '@/lib/server/model-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The one model catalog every surface reads.
 *
 * `?route=1` also returns the routing decision for the supplied requirements,
 * including why each model was excluded — a routing choice nobody can inspect is
 * indistinguishable from a guess.
 */
export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return NextResponse.json({ error: 'HII model discovery is local-only.' }, { status: 403 });
  }
  const url = new URL(request.url);
  const catalog = await readModelCatalog();
  if (url.searchParams.get('route') !== '1') return NextResponse.json(catalog);

  const list = (key: string) =>
    (url.searchParams.get(key) ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) as ModelModality[];
  const privacy = url.searchParams.get('privacy');
  return NextResponse.json({
    catalog,
    decision: routeModel(catalog, {
      inputModalities: list('input'),
      outputModalities: list('output'),
      needsImages: url.searchParams.get('images') === '1',
      ...(privacy === 'local' || privacy === 'external' ? { privacy: privacy as ModelPrivacy } : {}),
      override: url.searchParams.get('model')
    })
  });
}
